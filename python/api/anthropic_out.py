"""
Anthropic Messages API conversion utilities.

Converts between Anthropic Messages API format and OpenAI Chat Completions format,
so that clients using the Anthropic SDK can call our API server.

Anthropic Messages API spec: https://docs.anthropic.com/en/api/messages
"""

from __future__ import annotations

import json
import uuid
from typing import Any, AsyncIterator


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _gen_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:24]}"


def _sse_line(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8")


# ---------------------------------------------------------------------------
# Input conversion: Anthropic Messages API -> OpenAI Chat Completions
# ---------------------------------------------------------------------------

def convert_anthropic_input_to_messages(
    body: dict[str, Any],
) -> dict[str, Any]:
    """Convert an Anthropic Messages API request body to OpenAI Chat Completions format.

    Returns a dict with keys like ``messages``, ``model``, ``max_tokens``, etc.
    that can be fed directly into the Chat Completions pipeline.
    """

    messages: list[dict[str, Any]] = []

    # --- system ---
    system = body.get("system")
    if system is not None:
        system_text = _extract_system_text(system)
        if system_text:
            messages.append({"role": "system", "content": system_text})

    # --- messages ---
    for msg in body.get("messages", []):
        role = msg.get("role", "user")
        content = msg.get("content", "")

        if isinstance(content, str):
            messages.append({"role": role, "content": content})
        elif isinstance(content, list):
            converted = _convert_anthropic_content_blocks(role, content)
            messages.extend(converted)
        else:
            messages.append({"role": role, "content": str(content)})

    # --- Build result ---
    result: dict[str, Any] = {
        "model": body.get("model", "claude-3-sonnet"),
        "messages": messages,
    }

    # Forward common parameters
    if "max_tokens" in body:
        result["max_tokens"] = body["max_tokens"]
    if "temperature" in body:
        result["temperature"] = body["temperature"]
    if "top_p" in body:
        result["top_p"] = body["top_p"]
    if "stream" in body:
        result["stream"] = body["stream"]
    if "stop_sequences" in body:
        result["stop"] = body["stop_sequences"]

    # --- tools ---
    anthropic_tools = body.get("tools")
    if anthropic_tools:
        result["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": t.get("name", ""),
                    "description": t.get("description", ""),
                    "parameters": t.get("input_schema", {}),
                },
            }
            for t in anthropic_tools
        ]

    # --- tool_choice ---
    tool_choice = body.get("tool_choice")
    if tool_choice is not None:
        result["tool_choice"] = _convert_tool_choice(tool_choice)

    # Preserve thinking_effort for provider injection
    if body.get("thinking_effort") is not None:
        result["thinking_effort"] = body["thinking_effort"]

    return result


def _extract_system_text(system: Any) -> str:
    """Extract system text from the Anthropic ``system`` field.

    Anthropic accepts either a plain string or an array of content blocks.
    """
    if isinstance(system, str):
        return system
    if isinstance(system, list):
        parts: list[str] = []
        for block in system:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return "\n".join(parts)
    return str(system)


def _convert_anthropic_content_blocks(
    role: str,
    blocks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Convert an array of Anthropic content blocks to OpenAI messages.

    Special handling: ``tool_result`` and ``tool_use`` blocks produce their
    own separate messages (tool message / assistant with tool_calls).
    """
    result: list[dict[str, Any]] = []

    # Collect non-special blocks into a single message
    regular_parts: list[dict[str, Any]] = []

    for block in blocks:
        btype = block.get("type", "")

        if btype == "text":
            regular_parts.append({"type": "text", "text": block.get("text", "")})

        elif btype == "image":
            source = block.get("source", {})
            if source.get("type") == "base64":
                media_type = source.get("media_type", "image/png")
                data = source.get("data", "")
                url = f"data:{media_type};base64,{data}"
                regular_parts.append({
                    "type": "image_url",
                    "image_url": {"url": url},
                })

        elif btype == "tool_result":
            # Flush regular parts first
            if regular_parts:
                result.append({"role": role, "content": regular_parts})
                regular_parts = []

            tool_content = block.get("content", "")
            # Anthropic tool_result content can be a string or array of blocks
            if isinstance(tool_content, list):
                text_parts = []
                for c in tool_content:
                    if isinstance(c, dict) and c.get("type") == "text":
                        text_parts.append(c.get("text", ""))
                    elif isinstance(c, str):
                        text_parts.append(c)
                tool_content = "\n".join(text_parts)
            elif not isinstance(tool_content, str):
                tool_content = str(tool_content)

            result.append({
                "role": "tool",
                "tool_call_id": block.get("tool_use_id", ""),
                "content": tool_content,
            })

        elif btype == "tool_use":
            # Flush regular parts first
            if regular_parts:
                result.append({"role": role, "content": regular_parts})
                regular_parts = []

            arguments = block.get("input", {})
            if isinstance(arguments, dict):
                arguments = json.dumps(arguments)

            result.append({
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": block.get("id", ""),
                        "type": "function",
                        "function": {
                            "name": block.get("name", ""),
                            "arguments": arguments,
                        },
                    }
                ],
            })

    # Flush remaining regular parts
    if regular_parts:
        # Simplify single-text to string content
        if len(regular_parts) == 1 and regular_parts[0].get("type") == "text":
            result.append({"role": role, "content": regular_parts[0]["text"]})
        else:
            result.append({"role": role, "content": regular_parts})

    return result


def _convert_tool_choice(tool_choice: Any) -> Any:
    """Map Anthropic tool_choice to OpenAI tool_choice."""
    if isinstance(tool_choice, dict):
        t = tool_choice.get("type", "")
        if t == "auto":
            return "auto"
        if t == "any":
            return "required"
        if t == "tool":
            return {
                "type": "function",
                "function": {"name": tool_choice.get("name", "")},
            }
    if isinstance(tool_choice, str):
        return tool_choice
    return "auto"


# ---------------------------------------------------------------------------
# Output conversion: OpenAI Chat Completions -> Anthropic Messages API
# ---------------------------------------------------------------------------

def convert_chat_completion_to_anthropic(
    chat_resp: dict[str, Any],
    model: str,
    **kwargs: Any,
) -> dict[str, Any]:
    """Convert an OpenAI Chat Completions response to Anthropic Messages API format."""

    choices = chat_resp.get("choices", [])
    choice = choices[0] if choices else {}
    message = choice.get("message", {})
    usage = chat_resp.get("usage", {})

    content: list[dict[str, Any]] = []
    stop_reason = _finish_to_stop_reason(choice.get("finish_reason"))

    # Thinking/reasoning content
    reasoning_text = message.get("reasoning", "") or message.get("reasoning_content", "")
    if reasoning_text:
        content.append({"type": "thinking", "thinking": reasoning_text})

    # Text content
    text = message.get("content", "")
    if isinstance(text, str) and text:
        content.append({"type": "text", "text": text})

    # Tool calls
    tool_calls = message.get("tool_calls")
    if tool_calls and isinstance(tool_calls, list):
        stop_reason = "tool_use"
        for tc in tool_calls:
            fn = tc.get("function", {})
            arguments = fn.get("arguments", "{}")
            # Ensure arguments is a valid JSON string
            if isinstance(arguments, dict):
                arguments = json.dumps(arguments)
            content.append({
                "type": "tool_use",
                "id": tc.get("id", ""),
                "name": fn.get("name", ""),
                "input": json.loads(arguments) if isinstance(arguments, str) else arguments,
            })

    if not content:
        content.append({"type": "text", "text": ""})

    return {
        "id": _gen_id("msg"),
        "type": "message",
        "role": "assistant",
        "content": content,
        "model": model,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        },
    }


def _finish_to_stop_reason(finish_reason: str | None) -> str:
    """Map OpenAI finish_reason to Anthropic stop_reason."""
    mapping = {
        "stop": "end_turn",
        "length": "max_tokens",
        "tool_calls": "tool_use",
        "content_filter": "end_turn",
    }
    return mapping.get(finish_reason or "", "end_turn")


# ---------------------------------------------------------------------------
# Streaming: OpenAI Chat Completions SSE -> Anthropic Messages API SSE
# ---------------------------------------------------------------------------

async def stream_anthropic_api(
    provider_stream: AsyncIterator[bytes],
    model: str,
    **kwargs: Any,
) -> AsyncIterator[bytes]:
    """Convert an OpenAI Chat Completions SSE stream to Anthropic Messages API SSE events.

    Anthropic SSE event sequence:
      message_start -> content_block_start -> ping -> content_block_delta*
        -> content_block_stop -> message_delta -> message_stop

    For tool calls: additional tool_use content blocks are emitted after the
    text block (if any text was produced).
    """

    msg_id = _gen_id("msg")

    # Accumulators
    input_tokens = 0
    output_tokens = 0
    thinking_text = ""
    thinking_block_started = False
    thinking_block_finished = False
    thinking_block_index = -1
    text_started = False
    text_finished = False
    text_block_index = -1
    next_block_index = 0
    tool_call_buffers: dict[int, dict[str, str]] = {}

    # --- message_start ---
    yield _sse_line("message_start", {
        "type": "message_start",
        "message": {
            "id": msg_id,
            "type": "message",
            "role": "assistant",
            "content": [],
            "model": model,
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": 0, "output_tokens": 0},
        },
    })

    # --- ping ---
    yield _sse_line("ping", {"type": "ping"})

    # Process OpenAI SSE chunks
    async for chunk in provider_stream:
        raw = chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk)
        lines = raw.split("\n")

        for line in lines:
            trimmed = line.strip()
            if not trimmed.startswith("data: "):
                continue
            data = trimmed[6:].strip()
            if data == "[DONE]":
                continue

            try:
                parsed = json.loads(data)
            except json.JSONDecodeError:
                continue

            # Extract usage
            chunk_usage = parsed.get("usage")
            if chunk_usage:
                input_tokens = chunk_usage.get("prompt_tokens", input_tokens)
                output_tokens = chunk_usage.get("completion_tokens", output_tokens)

            choices = parsed.get("choices", [])
            if not choices:
                continue

            delta = choices[0].get("delta", {})
            finish_reason = choices[0].get("finish_reason")

            # --- Accumulate tool call deltas ---
            delta_tool_calls = delta.get("tool_calls")
            if delta_tool_calls and isinstance(delta_tool_calls, list):
                for tc in delta_tool_calls:
                    tc_index = tc.get("index", 0)
                    if tc_index not in tool_call_buffers:
                        tool_call_buffers[tc_index] = {
                            "id": tc.get("id", ""),
                            "name": (tc.get("function") or {}).get("name", ""),
                            "arguments": (tc.get("function") or {}).get("arguments", ""),
                        }
                    else:
                        buf = tool_call_buffers[tc_index]
                        if tc.get("id"):
                            buf["id"] = tc["id"]
                        fn = tc.get("function")
                        if fn:
                            if fn.get("name"):
                                buf["name"] = fn["name"]
                            if fn.get("arguments"):
                                buf["arguments"] += fn["arguments"]

            # --- Reasoning / thinking delta ---
            delta_reasoning = delta.get("reasoning")
            if delta_reasoning is None:
                delta_reasoning = delta.get("reasoning_content")
            if delta_reasoning is not None and delta_reasoning != "":
                if not thinking_block_started:
                    thinking_block_started = True
                    thinking_block_index = next_block_index
                    next_block_index += 1
                    yield _sse_line("content_block_start", {
                        "type": "content_block_start",
                        "index": thinking_block_index,
                        "content_block": {"type": "thinking", "thinking": ""},
                    })

                thinking_text += delta_reasoning
                yield _sse_line("content_block_delta", {
                    "type": "content_block_delta",
                    "index": thinking_block_index,
                    "delta": {"type": "thinking_delta", "thinking": delta_reasoning},
                })

            # --- Text delta ---
            delta_content = delta.get("content")
            if delta_content is not None and delta_content != "":
                # Close thinking block if it was started but not yet finished
                if thinking_block_started and not thinking_block_finished:
                    thinking_block_finished = True
                    yield _sse_line("content_block_stop", {
                        "type": "content_block_stop",
                        "index": thinking_block_index,
                    })

                if not text_started:
                    text_started = True
                    text_block_index = next_block_index
                    next_block_index += 1
                    yield _sse_line("content_block_start", {
                        "type": "content_block_start",
                        "index": text_block_index,
                        "content_block": {"type": "text", "text": ""},
                    })

                yield _sse_line("content_block_delta", {
                    "type": "content_block_delta",
                    "index": text_block_index,
                    "delta": {"type": "text_delta", "text": delta_content},
                })

            # --- Finish ---
            if finish_reason:
                stop_reason = _finish_to_stop_reason(finish_reason)

                # Close thinking block if open
                if thinking_block_started and not thinking_block_finished:
                    thinking_block_finished = True
                    yield _sse_line("content_block_stop", {
                        "type": "content_block_stop",
                        "index": thinking_block_index,
                    })

                # Close text block if open
                if text_started and not text_finished:
                    text_finished = True
                    yield _sse_line("content_block_stop", {
                        "type": "content_block_stop",
                        "index": text_block_index,
                    })

                # If no content block was emitted at all, emit an empty text block
                if not thinking_block_started and not text_started:
                    yield _sse_line("content_block_start", {
                        "type": "content_block_start",
                        "index": 0,
                        "content_block": {"type": "text", "text": ""},
                    })
                    yield _sse_line("content_block_stop", {
                        "type": "content_block_stop",
                        "index": 0,
                    })

                # Emit tool_use content blocks for each accumulated tool call
                for tc_idx in sorted(tool_call_buffers.keys()):
                    buf = tool_call_buffers[tc_idx]
                    input_obj = {}
                    try:
                        input_obj = json.loads(buf["arguments"])
                    except (json.JSONDecodeError, TypeError):
                        input_obj = {}

                    tc_block_index = next_block_index
                    next_block_index += 1

                    # content_block_start for tool_use
                    yield _sse_line("content_block_start", {
                        "type": "content_block_start",
                        "index": tc_block_index,
                        "content_block": {
                            "type": "tool_use",
                            "id": buf["id"],
                            "name": buf["name"],
                            "input": {},
                        },
                    })

                    # content_block_delta for tool_use input
                    yield _sse_line("content_block_delta", {
                        "type": "content_block_delta",
                        "index": tc_block_index,
                        "delta": {
                            "type": "input_json_delta",
                            "partial_json": json.dumps(input_obj),
                        },
                    })

                    # content_block_stop
                    yield _sse_line("content_block_stop", {
                        "type": "content_block_stop",
                        "index": tc_block_index,
                    })

                if tool_call_buffers:
                    stop_reason = "tool_use"

                # Update output token count from streaming usage if available
                # message_delta
                yield _sse_line("message_delta", {
                    "type": "message_delta",
                    "delta": {
                        "stop_reason": stop_reason,
                        "stop_sequence": None,
                    },
                    "usage": {"output_tokens": output_tokens},
                })

                # message_stop
                yield _sse_line("message_stop", {"type": "message_stop"})
                return

    # If we reach here without finish_reason, close gracefully
    if thinking_block_started and not thinking_block_finished:
        thinking_block_finished = True
        yield _sse_line("content_block_stop", {
            "type": "content_block_stop",
            "index": thinking_block_index,
        })

    if text_started and not text_finished:
        text_finished = True
        yield _sse_line("content_block_stop", {
            "type": "content_block_stop",
            "index": text_block_index,
        })
    elif not text_started and not thinking_block_started:
        # No content was emitted at all, emit an empty text block
        yield _sse_line("content_block_start", {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "text", "text": ""},
        })
        yield _sse_line("content_block_stop", {
            "type": "content_block_stop",
            "index": 0,
        })

    yield _sse_line("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": "end_turn", "stop_sequence": None},
        "usage": {"output_tokens": output_tokens},
    })

    yield _sse_line("message_stop", {"type": "message_stop"})
