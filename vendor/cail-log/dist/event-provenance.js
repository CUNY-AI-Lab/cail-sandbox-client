const VALIDATED_EVENTS = new WeakSet();
export function markValidatedEvent(event) {
    VALIDATED_EVENTS.add(event);
    return event;
}
export function assertValidatedEvent(event) {
    if (typeof event !== "object" ||
        event === null ||
        !VALIDATED_EVENTS.has(event)) {
        throw new TypeError("cail-log: sinks accept only events produced by createCailLogger");
    }
}
