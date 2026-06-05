"""
OpenAI Responses API conversion utilities.

Converts between Responses API format and Chat Completions format,
allowing us to reuse existing provider adapters.

Responses API spec: https://platform.openai.com/docs/api-reference/responses
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any, AsyncIterator


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _gen_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:24]}"


# ---------------------------------------------------------------------------
# Input conversion: Responses API -> Chat Completions
# ---------------------------------------------------------------------------

def convert_responses_input_to_messages(
    input_data: str | list[dict[str, Any]],
    instructions: str | None = None,
) -> list[dict[str, Any]]:
    """Convert Responses API input to Chat Completions messages array."""

    messages: list[dict[str, Any]] = []

    # Add instructions as system message
    if instructions and instructions.strip():
        messages.append({"role": "system", "content": instructions.strip()})

    # String input -> single user message
    if isinstance(input_data, str):
        messages.append({"role": "user", "content": input_data})
        return messages

    # Array of items
    for item in input_data:
        item_type = item.get("type") or _infer_item_type(item)

        if item_type == "message" or (item_type is None and "role" in item and "content" in item):
            role = _map_role(item.get("role", "user"))
            content = _convert_content(item.get("content", ""))
            messages.append({"role": role, "content": content})

        elif item_type == "function_call":
            messages.append({
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": item.get("call_id", ""),
                        "type": "function",
                        "function": {
                            "name": item.get("name", ""),
                            "arguments": item.get("arguments", ""),
                        },
                    }
                ],
            })

        elif item_type == "function_call_output":
            messages.append({
                "role": "tool",
                "content": item.get("output", ""),
                "tool_call_id": item.get("call_id", ""),
            })

        # Skip "reasoning" and "item_reference" items

    return messages


def _map_role(role: str) -> str:
    if role in ("developer", "system"):
        return "system"
    if role == "assistant":
        return "assistant"
    return "user"


def _infer_item_type(item: dict[str, Any]) -> str | None:
    """Infer the item type from its shape when `type` field is missing."""
    if "role" in item and "content" in item:
        return "message"
    if "call_id" in item and "name" in item and "arguments" in item:
        return "function_call"
    if "call_id" in item and "output" in item:
        return "function_call_output"
    return None


def _convert_content(content: Any) -> Any:
    """Convert Responses content parts to Chat Completions format."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return str(content)

    parts: list[dict[str, Any]] = []
    for part in content:
        ptype = part.get("type", "")
        if ptype in ("input_text", "output_text"):
            parts.append({"type": "text", "text": part.get("text", "")})
        elif ptype == "input_image" and part.get("image_url"):
            parts.append({
                "type": "image_url",
                "image_url": {"url": part["image_url"], "detail": part.get("detail", "auto")},
            })
        elif ptype == "refusal":
            parts.append({"type": "text", "text": part.get("refusal", "")})

    return parts if parts else ""


# ---------------------------------------------------------------------------
# Tools conversion: Responses API -> Chat Completions
# ---------------------------------------------------------------------------

def convert_responses_tools_to_chat_tools(
    tools: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Convert Responses API tools to Chat Completions tools format.

    Responses API: { type: "function", name, description, parameters }
    Chat Completions: { type: "function", function: { name, description, parameters } }
    """
    result: list[dict[str, Any]] = []
    for tool in tools:
        # Already in Chat Completions format
        if "function" in tool:
            result.append(tool)
            continue
        # Responses API format
        if tool.get("type") == "function":
            result.append({
                "type": "function",
                "function": {
                    "name": tool.get("name", ""),
                    "description": tool.get("description", ""),
                    "parameters": tool.get("parameters", {}),
                },
            })
        # Skip web_search, file_search, etc.
    return result


# ---------------------------------------------------------------------------
# Output conversion: Chat Completions -> Responses API
# ---------------------------------------------------------------------------

def convert_chat_completion_to_responses(
    chat_resp: dict[str, Any],
    model: str,
    *,
    instructions: str | None = None,
    previous_response_id: str | None = None,
    temperature: float | None = None,
    top_p: float | None = None,
) -> dict[str, Any]:
    """Convert a Chat Completions response to Responses API format."""

    now = int(time.time())
    choices = chat_resp.get("choices", [])
    choice = choices[0] if choices else {}
    message = choice.get("message", {})
    text = message.get("content", "") if isinstance(message.get("content"), str) else ""
    usage = chat_resp.get("usage", {})
    reasoning_text = message.get("reasoning", "") or message.get("reasoning_content", "")

    output_items: list[dict[str, Any]] = []

    # Reasoning output item
    if reasoning_text:
        output_items.append({
            "type": "reasoning",
            "id": _gen_id("rs"),
            "status": "completed",
            "summary": [{"type": "summary_text", "text": reasoning_text}],
        })

    # Message output item
    output_items.append({
        "type": "message",
        "id": _gen_id("msg"),
        "role": "assistant",
        "status": "completed",
        "content": [
            {
                "type": "output_text",
                "text": text,
                "annotations": [],
                "logprobs": [],
            }
        ],
    })

    return {
        "id": _gen_id("resp"),
        "object": "response",
        "created_at": now,
        "completed_at": now,
        "status": "completed",
        "incomplete_details": None,
        "model": model,
        "previous_response_id": previous_response_id,
        "instructions": instructions,
        "output": output_items,
        "error": None,
        "tools": [],
        "tool_choice": "auto",
        "truncation": "disabled",
        "parallel_tool_calls": True,
        "text": {"format": {"type": "text"}},
        "temperature": temperature if temperature is not None else 1,
        "top_p": top_p if top_p is not None else 1,
        "presence_penalty": 0,
        "frequency_penalty": 0,
        "top_logprobs": 0,
        "reasoning": None,
        "user": None,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
            "total_tokens": usage.get("prompt_tokens", 0) + usage.get("completion_tokens", 0),
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        },
        "max_output_tokens": None,
        "max_tool_calls": None,
        "store": False,
        "background": False,
        "service_tier": "default",
        "metadata": {},
        "safety_identifier": None,
        "prompt_cache_key": None,
    }


# ---------------------------------------------------------------------------
# Streaming: Chat Completions SSE -> Responses API SSE
# ---------------------------------------------------------------------------

_seq_counter = 0


def _next_seq() -> int:
    global _seq_counter
    _seq_counter += 1
    return _seq_counter


def _sse_line(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8")


async def stream_responses_api(
    provider_stream: AsyncIterator[bytes],
    model: str,
    *,
    instructions: str | None = None,
    previous_response_id: str | None = None,
    temperature: float | None = None,
    top_p: float | None = None,
) -> AsyncIterator[bytes]:
    """Convert a Chat Completions SSE stream to Responses API SSE stream."""

    global _seq_counter
    _seq_counter = 0

    now = int(time.time())
    resp_id = _gen_id("resp")
    item_id = _gen_id("msg")

    # Build base response
    base_response: dict[str, Any] = {
        "id": resp_id,
        "object": "response",
        "created_at": now,
        "completed_at": None,
        "status": "in_progress",
        "incomplete_details": None,
        "model": model,
        "previous_response_id": previous_response_id,
        "instructions": instructions,
        "output": [],
        "error": None,
        "tools": [],
        "tool_choice": "auto",
        "truncation": "disabled",
        "parallel_tool_calls": True,
        "text": {"format": {"type": "text"}},
        "temperature": temperature if temperature is not None else 1,
        "top_p": top_p if top_p is not None else 1,
        "presence_penalty": 0,
        "frequency_penalty": 0,
        "top_logprobs": 0,
        "reasoning": None,
        "user": None,
        "usage": None,
        "max_output_tokens": None,
        "max_tool_calls": None,
        "store": False,
        "background": False,
        "service_tier": "default",
        "metadata": {},
        "safety_identifier": None,
        "prompt_cache_key": None,
    }

    # Emit: response.created
    yield _sse_line("response.created", {
        "type": "response.created",
        "sequence_number": _next_seq(),
        "response": {**base_response},
    })

    # Emit: response.in_progress
    yield _sse_line("response.in_progress", {
        "type": "response.in_progress",
        "sequence_number": _next_seq(),
        "response": {**base_response},
    })

    # Track output items — emit lazily
    output_items: list[dict[str, Any]] = []
    current_output_index = -1
    message_item_emitted = False
    text_part_emitted = False

    message_item = {
        "type": "message",
        "id": item_id,
        "role": "assistant",
        "status": "in_progress",
        "content": [],
    }

    # Process Chat Completions stream
    accumulated_text = ""
    total_input_tokens = 0
    total_output_tokens = 0

    # Track tool calls being built
    tool_call_buffers: dict[int, dict[str, str]] = {}

    # Track reasoning output
    reasoning_text = ""
    reasoning_item_id = _gen_id("rs")
    reasoning_item_emitted = False
    reasoning_output_index = -1

    async for chunk in provider_stream:
        text = chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk)
        lines = text.split("\n")

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
                total_input_tokens = chunk_usage.get("prompt_tokens", total_input_tokens)
                total_output_tokens = chunk_usage.get("completion_tokens", total_output_tokens)

            choices = parsed.get("choices", [])
            if not choices:
                continue

            delta = choices[0].get("delta", {})
            finish_reason = choices[0].get("finish_reason")

            # --- Handle tool_calls in delta ---
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

            # --- Handle reasoning ---
            delta_reasoning = delta.get("reasoning")
            if delta_reasoning is not None and delta_reasoning != "":
                if not reasoning_item_emitted:
                    reasoning_item_emitted = True
                    reasoning_output_index = len(output_items)
                    reasoning_item = {
                        "type": "reasoning",
                        "id": reasoning_item_id,
                        "status": "completed",
                        "summary": [
                            {"type": "summary_text", "text": ""},
                        ],
                    }
                    output_items.append(reasoning_item)
                    yield _sse_line("response.output_item.added", {
                        "type": "response.output_item.added",
                        "sequence_number": _next_seq(),
                        "output_index": reasoning_output_index,
                        "item": reasoning_item,
                    })

                reasoning_text += delta_reasoning
                yield _sse_line("response.reasoning_summary_text.delta", {
                    "type": "response.reasoning_summary_text.delta",
                    "sequence_number": _next_seq(),
                    "item_id": reasoning_item_id,
                    "output_index": reasoning_output_index,
                    "summary_index": 0,
                    "delta": delta_reasoning,
                })

            # --- Handle text content ---
            delta_content = delta.get("content")
            if delta_content is not None and delta_content != "":
                # Emit message item header if not yet emitted
                if not message_item_emitted:
                    message_item_emitted = True
                    current_output_index = len(output_items)
                    output_items.append(message_item)
                    yield _sse_line("response.output_item.added", {
                        "type": "response.output_item.added",
                        "sequence_number": _next_seq(),
                        "output_index": current_output_index,
                        "item": message_item,
                    })

                # Emit text part header if not yet emitted
                if not text_part_emitted:
                    text_part_emitted = True
                    yield _sse_line("response.content_part.added", {
                        "type": "response.content_part.added",
                        "sequence_number": _next_seq(),
                        "item_id": item_id,
                        "output_index": current_output_index,
                        "content_index": 0,
                        "part": {"type": "output_text", "text": "", "annotations": [], "logprobs": []},
                    })

                accumulated_text += delta_content
                yield _sse_line("response.output_text.delta", {
                    "type": "response.output_text.delta",
                    "sequence_number": _next_seq(),
                    "item_id": item_id,
                    "output_index": current_output_index,
                    "content_index": 0,
                    "delta": delta_content,
                })

            # --- Finish ---
            if finish_reason:
                # Finalize reasoning if emitted
                if reasoning_item_emitted:
                    yield _sse_line("response.reasoning_summary_text.done", {
                        "type": "response.reasoning_summary_text.done",
                        "sequence_number": _next_seq(),
                        "item_id": reasoning_item_id,
                        "output_index": reasoning_output_index,
                        "summary_index": 0,
                        "text": reasoning_text,
                    })
                    yield _sse_line("response.output_item.done", {
                        "type": "response.output_item.done",
                        "sequence_number": _next_seq(),
                        "output_index": reasoning_output_index,
                        "item": {
                            "type": "reasoning",
                            "id": reasoning_item_id,
                            "status": "completed",
                            "summary": [
                                {"type": "summary_text", "text": reasoning_text},
                            ],
                        },
                    })

                # Finalize tool calls
                for tc_idx, tc_buf in tool_call_buffers.items():
                    fc_id = _gen_id("fc")
                    call_id = tc_buf["id"] or f"call_{tc_idx}"
                    fc_item = {
                        "type": "function_call",
                        "id": fc_id,
                        "call_id": call_id,
                        "name": tc_buf["name"],
                        "arguments": tc_buf["arguments"],
                        "status": "completed",
                    }
                    fc_output_index = len(output_items)
                    output_items.append(fc_item)
                    yield _sse_line("response.output_item.added", {
                        "type": "response.output_item.added",
                        "sequence_number": _next_seq(),
                        "output_index": fc_output_index,
                        "item": fc_item,
                    })
                    yield _sse_line("response.output_item.done", {
                        "type": "response.output_item.done",
                        "sequence_number": _next_seq(),
                        "output_index": fc_output_index,
                        "item": fc_item,
                    })

                # Finalize text if emitted
                if text_part_emitted:
                    yield _sse_line("response.output_text.done", {
                        "type": "response.output_text.done",
                        "sequence_number": _next_seq(),
                        "item_id": item_id,
                        "output_index": current_output_index,
                        "content_index": 0,
                        "text": accumulated_text,
                    })
                    yield _sse_line("response.content_part.done", {
                        "type": "response.content_part.done",
                        "sequence_number": _next_seq(),
                        "item_id": item_id,
                        "output_index": current_output_index,
                        "content_index": 0,
                        "part": {
                            "type": "output_text",
                            "text": accumulated_text,
                            "annotations": [],
                            "logprobs": [],
                        },
                    })

                if message_item_emitted:
                    yield _sse_line("response.output_item.done", {
                        "type": "response.output_item.done",
                        "sequence_number": _next_seq(),
                        "output_index": current_output_index,
                        "item": {
                            "type": "message",
                            "id": item_id,
                            "role": "assistant",
                            "status": "completed",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": accumulated_text,
                                    "annotations": [],
                                    "logprobs": [],
                                }
                            ] if text_part_emitted else [],
                        },
                    })

                # Build final output list
                final_output: list[dict[str, Any]] = []
                for item in output_items:
                    if item.get("type") == "message":
                        final_output.append({
                            "type": "message",
                            "id": item_id,
                            "role": "assistant",
                            "status": "completed",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": accumulated_text,
                                    "annotations": [],
                                    "logprobs": [],
                                }
                            ] if text_part_emitted else [],
                        })
                    elif item.get("type") == "reasoning":
                        final_output.append({
                            "type": "reasoning",
                            "id": reasoning_item_id,
                            "status": "completed",
                            "summary": [
                                {"type": "summary_text", "text": reasoning_text},
                            ],
                        })
                    else:
                        final_output.append(item)

                # response.completed
                completed_response = {
                    **base_response,
                    "status": "completed",
                    "completed_at": int(time.time()),
                    "output": final_output,
                    "usage": {
                        "input_tokens": total_input_tokens,
                        "output_tokens": total_output_tokens,
                        "total_tokens": total_input_tokens + total_output_tokens,
                        "input_tokens_details": {"cached_tokens": 0},
                        "output_tokens_details": {"reasoning_tokens": 0},
                    },
                }

                yield _sse_line("response.completed", {
                    "type": "response.completed",
                    "sequence_number": _next_seq(),
                    "response": completed_response,
                })

                yield b"data: [DONE]\n\n"
                return

    # If we reach here without finish_reason, still emit completed
    final_output = []
    if reasoning_item_emitted:
        final_output.append({
            "type": "reasoning",
            "id": reasoning_item_id,
            "status": "completed",
            "summary": [
                {"type": "summary_text", "text": reasoning_text},
            ],
        })
    if message_item_emitted or accumulated_text:
        final_output.append({
            "type": "message",
            "id": item_id,
            "role": "assistant",
            "status": "completed",
            "content": [
                {
                    "type": "output_text",
                    "text": accumulated_text,
                    "annotations": [],
                    "logprobs": [],
                }
            ],
        })
    for tc_buf in tool_call_buffers.values():
        final_output.append({
            "type": "function_call",
            "id": _gen_id("fc"),
            "call_id": tc_buf["id"],
            "name": tc_buf["name"],
            "arguments": tc_buf["arguments"],
            "status": "completed",
        })

    completed_response = {
        **base_response,
        "status": "completed",
        "completed_at": int(time.time()),
        "output": final_output,
        "usage": {
            "input_tokens": total_input_tokens,
            "output_tokens": total_output_tokens,
            "total_tokens": total_input_tokens + total_output_tokens,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        },
    }

    yield _sse_line("response.completed", {
        "type": "response.completed",
        "sequence_number": _next_seq(),
        "response": completed_response,
    })

    yield b"data: [DONE]\n\n"
