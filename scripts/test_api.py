"""Test compat_mode direct agent.run.

使用 .env 中的 KEY/URL/MODEL 调用真实 LLM API，
验证兼容模式（compat_mode=True）下 Agent 的直接调用和响应解析。
"""

import asyncio
from pathlib import Path

from bellis.agent.decision import LiveDeps, create_decision_agent
from bellis.core.models import EmotionState, PersonaConfig, SceneContext


def load_env():
    """从项目根目录 .env 文件加载 LLM 配置。

    Returns:
        包含 api_key、base_url、model 三个键的字典。
    """
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
    """兼容模式下直接调用 Agent 并解析响应的测试函数。"""
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
        # output_type=str 时用 result.output
        output = result.output
        print(f"Output type: {type(output).__name__}")
        print(f"Output: {output!r}")

        from bellis.agent.decision import _parse_compat_response
        response = _parse_compat_response(output)
        print(f"Parsed: text={response.text}")
        print(f"emotion={response.emotion.value}, motion={response.motion.value}")
    except Exception as e:
        print(f"Error: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(test())
