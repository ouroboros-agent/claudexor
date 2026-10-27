import type { HarnessEvent, HarnessSpeech } from "@claudexor/schema";
import { newId } from "@claudexor/util";

type Json = any;

/**
 * Claude speech identity, from observed MAIN-conversation lifecycles only.
 * With --include-partial-messages each response is one incarnation:
 * `message_start` … `message_stop`. Its text blocks run
 * `content_block_start(i)` → deltas → one complete assistant frame for exactly
 * that block → `content_block_stop(i)` (recorded on 2.1.311:
 * fixtures/recorded-partial-*.jsonl). The adapter issues one opaque key per
 * observed text block of one incarnation in one parser instance; the native
 * message id only has to agree, because a retried response can replay it.
 * Text, timing, adjacency and frame counts never decide identity, and every
 * ambiguous case stays unkeyed.
 */
interface BlockLifecycle {
  /** Issued key; undefined for non-text, id-disagreeing or duplicated (invalidated) blocks. */
  key: string | undefined;
  open: boolean;
  completed: boolean;
}

interface Incarnation {
  ordinal: number;
  /** `event.message.id` of the observed message_start; null proves no completion. */
  id: string | null;
  /** The CLI joins text runs into deferred frames: no completion is ever exact. */
  joined: boolean;
  blocks: Map<number, BlockLifecycle>;
}

export interface ClaudeSpeechState {
  /** Per-parser-instance namespace: keys stay unique when a session id repeats. */
  readonly namespace: string;
  incarnations: number;
  current: Incarnation | null;
}

export function createClaudeSpeechState(): ClaudeSpeechState {
  return { namespace: newId(), incarnations: 0, current: null };
}

export function closeClaudeSpeech(state: ClaudeSpeechState): void {
  state.current = null;
}

function nativeId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function blockIndex(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

/** A frame's own `api_message_id` (newer CLIs) must agree with its incarnation when present. */
function agrees(frame: Json, incarnation: Incarnation): boolean {
  return frame.api_message_id === undefined || frame.api_message_id === incarnation.id;
}

/**
 * The completion an assistant frame proves: exactly one non-empty text block,
 * not an interrupted partial, the incarnation's own id, inside the single open
 * block, which is keyed and not yet completed, and never in a joined run.
 */
export function claudeCompletion(obj: Json, state: ClaudeSpeechState): HarnessSpeech | undefined {
  const incarnation = state.current;
  const content = obj.message?.content;
  if (!incarnation || incarnation.joined || incarnation.id === null || obj.aborted === true) {
    return undefined;
  }
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const block = content[0];
  if (block?.type !== "text" || typeof block.text !== "string" || block.text.length === 0) {
    return undefined;
  }
  if (nativeId(obj.message?.id) !== incarnation.id) return undefined;
  const open = [...incarnation.blocks.values()].filter((lifecycle) => lifecycle.open);
  const target = open.length === 1 ? open[0] : undefined;
  if (!target?.key || target.completed) return undefined;
  target.completed = true;
  return { key: target.key, op: "complete" };
}

/**
 * `stream_event` frames (--include-partial-messages, F2.5 W-C4). Only MAIN
 * conversation text deltas become delta messages; subagent frames carry
 * parent_tool_use_id and never surface or touch the lifecycle. Block
 * boundaries, thinking and tool-input deltas are recognized plumbing.
 */
export function claudeStreamEvents(
  obj: Json,
  sessionId: string,
  ts: string,
  state: ClaudeSpeechState,
): HarnessEvent[] {
  if (obj.parent_tool_use_id != null) return [];
  const event = obj.event;
  const incarnation = state.current;
  const index = blockIndex(event?.index);
  const lifecycle = index === null ? undefined : incarnation?.blocks.get(index);
  switch (event?.type) {
    case "message_start": {
      const id = nativeId(event.message?.id);
      state.incarnations += 1;
      state.current = {
        ordinal: state.incarnations,
        // A start frame naming another response than its own message proves no id.
        id: obj.api_message_id === undefined || obj.api_message_id === id ? id : null,
        joined: obj.text_runs_joined === true,
        blocks: new Map(),
      };
      return [];
    }
    case "content_block_start":
      if (!incarnation || index === null) return [];
      if (lifecycle) {
        // A second start for one index is ambiguous: the index stays unkeyed.
        lifecycle.key = undefined;
        lifecycle.open = true;
        return [];
      }
      incarnation.blocks.set(index, {
        key:
          event.content_block?.type === "text" &&
          incarnation.id !== null &&
          agrees(obj, incarnation)
            ? `claude:${state.namespace}:${incarnation.ordinal}:${index}`
            : undefined,
        open: true,
        completed: false,
      });
      return [];
    case "content_block_stop":
      if (!incarnation || !lifecycle) return [];
      // A stop naming another response neither closes this block nor leaves its
      // lifecycle exact: the block loses its key and stays counted as open.
      if (agrees(obj, incarnation)) lifecycle.open = false;
      else lifecycle.key = undefined;
      return [];
    case "message_stop":
      if (incarnation && !agrees(obj, incarnation)) {
        // A stop naming another response neither ends this incarnation nor states
        // its abandonment, and nothing in it stays exactly attributable.
        incarnation.id = null;
        for (const block of incarnation.blocks.values()) block.key = undefined;
        return [];
      }
      closeClaudeSpeech(state);
      return incarnation ? abandonedEvents(obj.abandoned_blocks, incarnation, sessionId, ts) : [];
    case "content_block_delta":
      break;
    default:
      return [];
  }
  const delta = event.delta;
  if (delta?.type !== "text_delta" || typeof delta.text !== "string" || !delta.text) return [];
  if (lifecycle && incarnation && !agrees(obj, incarnation)) lifecycle.key = undefined;
  const key = lifecycle?.open && !lifecycle.completed && lifecycle.key ? lifecycle.key : undefined;
  return [
    {
      type: "message",
      session_id: sessionId,
      ts,
      text: delta.text,
      ...(key ? { speech: { key, op: "fragment" as const } } : {}),
      payload: { delta: true },
    },
  ];
}

/**
 * `message_stop.abandoned_blocks` is the CLI's own statement that blocks at
 * `from_block_index` and above will never get a complete frame. Only that
 * explicit statement marks an uncompleted keyed block abandoned; its partial
 * fragments stay exactly as emitted.
 */
function abandonedEvents(
  raw: Json,
  incarnation: Incarnation,
  sessionId: string,
  ts: string,
): HarnessEvent[] {
  const from = blockIndex(raw?.from_block_index);
  if (from === null || incarnation.id === null || raw.api_message_id !== incarnation.id) return [];
  return [...incarnation.blocks.entries()]
    .filter(([index, lifecycle]) => index >= from && lifecycle.key && !lifecycle.completed)
    .sort(([a], [b]) => a - b)
    .map(([, lifecycle]): HarnessEvent => ({
      type: "status",
      session_id: sessionId,
      ts,
      text: "streamed text abandoned by the CLI",
      speech: { key: lifecycle.key!, op: "abandoned" },
      payload: { code: "speech_abandoned", from_block_index: from },
    }));
}
