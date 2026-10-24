"""Droid check: only our tools are available, and Droid can call them.

Needs the `droid` CLI on PATH and FACTORY_API_KEY in .env. From the repo root:

    uv run --project core python scripts/check_droid.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))

from countersign.config import settings  # noqa: E402

from droid_sdk import Session, SessionConfig, ToolCall, ToolResult  # noqa: E402
from droid_sdk.mcp import create_sdk_mcp_server, tool  # noqa: E402

CALLS: list[str] = []


@tool("get_secret_number", "Return the number the user asked about.")
def get_secret_number(name: str) -> str:
    CALLS.append(name)
    return f"The number for {name} is 4471."


async def main() -> int:
    if settings.factory_api_key:
        os.environ.setdefault("FACTORY_API_KEY", settings.factory_api_key)
    server = create_sdk_mcp_server("countersign-check", [get_secret_number])

    # Pass 1: discover the id Droid gives our tool.
    async with Session(config=SessionConfig(mcp_servers=[server])) as s:
        tools = await s.list_tools()
    ours = [t.id for t in tools if "get_secret_number" in t.id]
    print(f"Droid offers {len(tools)} tools by default; ours is: {ours}")
    if not ours:
        print("Our tool wasn't found. Ids seen:", [t.id for t in tools])
        return 1

    # Pass 2: restrict to our tool only.
    config = SessionConfig(mcp_servers=[server], restrict_tools=ours, auto_reject_permission_requests=False)
    async with Session(config=config) as s:
        allowed = [t.id for t in await s.list_tools() if t.allowed]
        print(f"Allowed with restrict_tools: {allowed}")
        prompt = ("First try to list the files in the current directory. Then call get_secret_number "
                  "with name='framing' and tell me the number.")
        async with s.stream(prompt, timeout=120) as stream:
            async for event in stream:
                if isinstance(event, ToolCall):
                    print(f"  tool call: {event.name}")
                elif isinstance(event, ToolResult):
                    print(f"  tool result ({event.tool_name}): {str(event.content)[:80]}")
        print(f"Result: {stream.result.subtype}")

    builtin_leaked = [t for t in allowed if t not in ours]
    print()
    print("PASS: only our tool is allowed and Droid used it." if CALLS and not builtin_leaked
          else f"CHECK: calls={CALLS} extra_allowed={builtin_leaked}")
    return 0 if CALLS and not builtin_leaked else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
