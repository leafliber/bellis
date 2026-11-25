"""Bounded audience intake and journaled, first-ballot voting."""

import asyncio
import re
import time
import unicodedata as ud
from collections import deque
from collections.abc import Callable, Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass, replace
from threading import RLock
from typing import Literal, cast
from uuid import uuid4

from .safety import IntentRequest, SafetyCore, SafetyError
from .store import HostStore, IntentSource, IntentState

_INJECTION = re.compile(
    r"(?:ignore|forget|override|disregard|bypass)\b.{0,48}\b(?:instructions?|rules?|prompts?)"
    r"|(?:reveal|repeat|print|show)\b.{0,32}\b(?:system prompt|api key|instructions?)"
    r"|(?:忽略|无视|忘记|覆盖|绕过|跳过).{0,24}(?:指令|指示|提示|规则|设定|要求|限制)"
    r"|(?:显示|输出|泄露|复述).{0,16}(?:系统提示|系统指令|密钥)"
    r"|(?:you are now|act as)\s+(?:an?\s+)?(?:system|developer|unrestricted|admin)\b"
    r"|(?:你现在是|请扮演)(?:系统|开发者|管理员)|(?:进入|开启)(?:开发者|越狱)模式"
    r"|(?:^|\s)(?:system|developer|assistant)\s*:|<\|(?:im_start|im_end|system)\|>|\[/?INST\]",
    re.I,
)


def _visible(raw: str) -> str:
    return "".join(
        " " if c.isspace() else c
        for c in ud.normalize("NFKC", raw)
        if (c.isspace() or not ud.category(c).startswith("C"))
        and c not in "\u034f\u115f\u1160\u17b4\u17b5\u3164\uffa0"
        and not 0x180B <= ord(c) <= 0x180F
        and not 0xFE00 <= ord(c) <= 0xFE0F
        and not 0xE0100 <= ord(c) <= 0xE01EF
    )


def sanitize_name(raw: str, max_len: int = 24) -> str:
    name = "".join(c for c in _visible(raw) if c.isalpha() or c.isdigit() or c in "_-·")
    return name[:max_len] or "观众"


def sanitize_text(raw: str, max_len: int = 120) -> str:
    return " ".join(_visible(raw).split())[:max_len].rstrip()


def looks_like_injection(text: str) -> bool:
    return _INJECTION.search(_visible(text)) is not None


def normalize_ballot(text: str) -> str:
    return "".join(c for c in _visible(text).lower() if ud.category(c)[0] not in "CPSZ")


@dataclass(frozen=True)
class DanmakuCandidate:
    candidate_id: str
    viewer_name: str
    text: str
    count: int


@dataclass(frozen=True)
class VoteSnapshot:
    vote_id: str
    question: str
    options: tuple[str, ...]
    counts: tuple[int, ...]
    phase: Literal["open", "closed"]
    remaining_s: float
    outcome: Literal["winner", "tie", "none"] | None
    winners: tuple[int, ...]  # Zero-based option index for a unique winner.


class AudienceHub:
    def __init__(
        self,
        safety: SafetyCore,
        store: HostStore,
        *,
        max_queue: int = 128,
        max_batch_candidates: int = 6,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if min(max_queue, max_batch_candidates) < 1:
            raise ValueError("expected positive audience limits")
        self._safety, self._store, self._clock = safety, store, clock
        self._queue: deque[tuple[str, str]] = deque(maxlen=max_queue)
        self._limit = max_batch_candidates
        self._lock = RLock()
        self._vote: VoteSnapshot | None = None
        self._ended: VoteSnapshot | None = None
        self._deadline = 0.0
        self._wake: Callable[[], object] | None = None
        self._voters: set[str] = set()
        self._ballots: dict[str, int] = {}

    def ingest(self, viewer_id: str, viewer_name: str, text: str) -> bool:
        text = sanitize_text(text)
        if not text or looks_like_injection(text):
            return False
        with self._lock:
            vote = self._vote
            if (
                vote
                and self._clock() < self._deadline
                and viewer_id
                and viewer_id not in self._voters
            ):
                index = self._ballots.get(normalize_ballot(text))
                if index is not None:
                    counts = list(vote.counts)
                    counts[index] += 1
                    self._vote = replace(vote, counts=tuple(counts))
                    self._voters.add(viewer_id)
            self._queue.append((sanitize_name(viewer_name), text))
        return True

    def drain_candidates(self) -> tuple[DanmakuCandidate, ...]:
        merged: dict[str, DanmakuCandidate] = {}
        with self._lock:
            while self._queue:
                name, text = self._queue.popleft()
                key = normalize_ballot(text) or text
                if candidate := merged.get(key):
                    merged[key] = replace(candidate, count=candidate.count + 1)
                elif len(merged) < self._limit:
                    merged[key] = DanmakuCandidate(f"c-{len(merged) + 1}", name, text, 1)
        return tuple(merged.values())

    def start_vote(
        self,
        question: str,
        options: Sequence[str],
        duration_s: int,
        *,
        holder: str = "director",
        source: IntentSource = IntentSource.AGENT,
    ) -> tuple[VoteSnapshot, str]:
        if isinstance(options, str) or not 2 <= len(options) <= 4:
            raise ValueError("expected two to four options")
        if type(duration_s) is not int or not 10 <= duration_s <= 300:
            raise ValueError("duration must be 10 to 300 seconds")
        question = sanitize_text(question)
        labels = tuple(sanitize_text(o) for o in options)
        ballots = {normalize_ballot(label): i for i, label in enumerate(labels)}
        if not question or "" in ballots or len(ballots) != len(labels):
            raise ValueError("expected a question and distinct non-empty options")
        with self._lock:
            if self._vote:
                raise ValueError("vote already open")
            vote_id = uuid4().hex
            vote = VoteSnapshot(
                vote_id, question, labels, (0,) * len(labels), "open", float(duration_s), None, ()
            )
            payload = {"question": question, "options": list(labels), "duration_s": duration_s}
            gate = self._safety.authorize_intent(
                IntentRequest(
                    holder,
                    f"vote:{vote_id}",
                    "vote.start",
                    "audience.vote",
                    payload,
                    source,
                    frozenset({"vote.start"}),
                    time_sensitive=True,
                )
            )
            if not gate.allowed or not gate.intent or gate.duplicate:
                raise SafetyError(gate.reason)
            self._store.mark_executing(gate.intent.id)
            self._store.finish_intent(gate.intent.id, IntentState.SUCCEEDED, result={"id": vote_id})
            self._vote = vote
            self._deadline = self._clock() + duration_s
            self._voters.clear()
            self._ballots = ballots | {str(i + 1): i for i in range(len(labels))}
        choices = "，".join(f"{i}号 {label}" for i, label in enumerate(labels, 1))
        return vote, f"来投个票吧！{question} {choices}。投票时间{duration_s}秒。"

    def start_vote_fields(
        self,
        data: Mapping[str, object],
        *,
        holder: str = "director",
        source: IntentSource = IntentSource.AGENT,
    ) -> tuple[VoteSnapshot, str]:
        if data.keys() - {"action", "question", "options", "duration_s"}:
            raise ValueError("unexpected vote field")
        question, options, duration = (
            data.get("question"),
            data.get("options"),
            data.get("duration_s"),
        )
        if (
            not isinstance(question, str)
            or not isinstance(options, list)
            or type(duration) is not int
        ):
            raise ValueError("expected question, options and integer duration_s")
        labels = cast(list[object], options)
        if not all(isinstance(label, str) for label in labels):
            raise ValueError("expected text options")
        return self.start_vote(
            question, cast(list[str], labels), duration, holder=holder, source=source
        )

    async def close_at_deadline(self, vote: VoteSnapshot) -> tuple[VoteSnapshot, str] | None:
        loop, closed = asyncio.get_running_loop(), asyncio.Event()
        with self._lock:
            current = self.active_vote()
            if not current or current.vote_id != vote.vote_id:
                return None
            self._wake = lambda: loop.call_soon_threadsafe(closed.set)
        try:
            with suppress(TimeoutError):
                await asyncio.wait_for(closed.wait(), current.remaining_s)
        finally:
            with self._lock:
                owns_vote = self._vote and self._vote.vote_id == vote.vote_id
                result = self.close_vote() if owns_vote else None
        return result

    def close_vote(self) -> tuple[VoteSnapshot, str] | None:
        with self._lock:
            if not (vote := self._vote):
                return None
            high = max(vote.counts)
            leaders = tuple(i for i, n in enumerate(vote.counts) if n == high and high)
            outcome = "none" if not leaders else "winner" if len(leaders) == 1 else "tie"
            winners = leaders if outcome == "winner" else ()
            ended = replace(vote, phase="closed", remaining_s=0, outcome=outcome, winners=winners)
            self._ended, self._vote = ended, None
            if self._wake:
                self._wake()
                self._wake = None
            self._voters.clear()
        names = "、".join(vote.options[i] for i in leaders)
        result = {"none": "这次没有收到投票", "winner": f"{names}获胜", "tie": f"{names}平票"}
        return ended, f"投票结束，{result[outcome]}。"

    def active_vote(self) -> VoteSnapshot | None:
        with self._lock:
            if self._vote:
                return replace(self._vote, remaining_s=max(0, self._deadline - self._clock()))
            return None

    def last_ended_vote(self) -> VoteSnapshot | None:
        with self._lock:
            return self._ended

    def pending_count(self) -> int:
        with self._lock:
            return len(self._queue)
