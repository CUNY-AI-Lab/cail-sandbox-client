const REDACTED = "[REDACTED]";
const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");
export class Sensitive {
    #value;
    constructor(value) {
        this.#value = value;
    }
    get value() {
        return this.#value;
    }
    toString() {
        return REDACTED;
    }
    toJSON() {
        return REDACTED;
    }
    [inspectSymbol]() {
        return REDACTED;
    }
}
export function sensitive(value) {
    return new Sensitive(value);
}
export function isSensitive(value) {
    return value instanceof Sensitive;
}
