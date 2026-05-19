"""Test compat_mode direct agent.run."""
import asyncio
from pathlib import Path

from bellis.graph.decision import create_decision_agent, LiveDeps
from bellis.core.models import EmotionState, PersonaConfig, SceneContext


def load_env():
    env = {"api_key": None, "base_url": None, "model": None}
    p = Path(__file__).resolve().parent.parent / ".env"
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            k = k.strip().upper()
            v = v.strip()
            if k == "KEY":
                env["api_key"] = v
            elif k == "URL":
                env["base_url"] = v
            elif k == "MODEL":
                env["model"] = v
    return env


async def test():
    env = load_env()
    model_str = "openai:" + (env["model"] or "gpt-4o-mini")
    print(f"Model: {model_str}")

    agent = create_decision_agent(
        model=model_str,
        base_url=env["base_url"],
        api_key=env["api_key"],
        compat_mode=True,
    )
    deps = LiveDeps(
        scene_context=SceneContext(),
        emotion_state=EmotionState(),
        persona=PersonaConfig(name="default", system_prompt="回复简短。"),
        action_history=[],
    )

    try:
        result = await agent.run("事件内容：你好主播！", deps=deps)
        output = result.get_output()
        print(f"Output type: {type(output).__name__}")
        print(f"Output: {output!r}")
    except Exception as e:
        print(f"Error: {type(e).__name__}: {e}")


if __name__ == "__main__":
    asyncio.run(test())
