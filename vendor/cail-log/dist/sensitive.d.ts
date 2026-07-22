declare const inspectSymbol: unique symbol;
export declare class Sensitive<Value> {
    #private;
    constructor(value: Value);
    get value(): Value;
    toString(): string;
    toJSON(): string;
    [inspectSymbol](): string;
}
export declare function sensitive<Value>(value: Value): Sensitive<Value>;
export declare function isSensitive(value: unknown): value is Sensitive<unknown>;
export {};
//# sourceMappingURL=sensitive.d.ts.map