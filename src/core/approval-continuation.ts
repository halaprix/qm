const CONVERSATION_KINDS = new Set(["dm", "channel", "group"]);

export function approvalContinuation(request: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!request) return null;
  const actor = request.actor as { externalId?: unknown } | undefined;
  const conversation = request.conversation as { kind?: unknown } | undefined;
  if (typeof actor?.externalId !== "string" || typeof request.text !== "string") return null;
  if (!CONVERSATION_KINDS.has(String(conversation?.kind))) return null;
  const {
    surface: _surface,
    async: _async,
    idempotencyKey: _idempotencyKey,
    redeliveryKey: _redeliveryKey,
    approval: _approval,
    relayInput: _relayInput,
    intakePreambleMs: _intakePreambleMs,
    clientSentAt: _clientSentAt,
    ...turn
  } = request;
  return turn;
}
