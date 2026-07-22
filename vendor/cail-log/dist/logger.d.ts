import { type CailEventCatalog, type CailEventDefinition, type CailLogEnvironment, type CailLogAttributeValue, type CailLogEvent, type CailLogFields, type CailOutcome, type CailPlatformLogFieldName, type CailSourceClass, type CailTerminalFields } from "./schema.js";
export type CailLogDiagnosticCode = "clock_error" | "event_contract_error" | "event_invalid" | "event_dropped" | "sink_error";
export type CailLogSink = (event: CailLogEvent) => unknown;
export type CailLogDiagnosticSink = (code: CailLogDiagnosticCode) => unknown;
type CailLoggerOptionsBase<Catalog extends CailEventCatalog, Source extends CailSourceClass> = {
    service: string;
    release: string;
    env: CailLogEnvironment;
    sourceClass: Source;
    catalog: Catalog;
    sink: CailLogSink;
    onDiagnostic?: CailLogDiagnosticSink;
    clock?: () => number;
};
export type CailLoggerOptions<Catalog extends CailEventCatalog, Source extends CailSourceClass> = CailLoggerOptionsBase<Catalog, Source> & (Source extends "platform" ? {
    subjectVersion: string;
} : {
    subjectVersion?: never;
});
type CailEventNameFor<Catalog extends CailEventCatalog, Source extends CailSourceClass> = {
    [Event in Extract<keyof Catalog, string>]: Extract<Catalog[Event]["source"], Source | "both"> extends never ? never : Event;
}[Extract<keyof Catalog, string>];
type CailRequiredFieldNames<Definition extends CailEventDefinition> = Extract<Definition["required"][number], CailPlatformLogFieldName>;
type CailOptionalFieldNames<Definition extends CailEventDefinition> = Extract<Definition["optional"][number], CailPlatformLogFieldName>;
type CailAllowedOutcomes<Definition extends CailEventDefinition> = Definition extends {
    outcomes: readonly (infer Outcome)[];
} ? Outcome : CailOutcome;
type CailAllowedReasons<Definition extends CailEventDefinition> = Definition extends {
    terminal_reasons: readonly (infer Reason)[];
} ? Reason : CailTerminalFields["reason"];
type CailTerminalFor<Definition extends CailEventDefinition> = CailTerminalFields extends infer Terminal ? Terminal extends CailTerminalFields ? Terminal["outcome"] extends CailAllowedOutcomes<Definition> ? Terminal["reason"] extends CailAllowedReasons<Definition> ? Terminal : never : never : never : never;
type CailFieldValue<Definition extends CailEventDefinition, Source extends CailSourceClass, Field extends keyof CailLogFields<Source>> = Field extends "terminal" ? CailTerminalFor<Definition> : NonNullable<CailLogFields<Source>[Field]>;
type CailFieldsFor<Definition extends CailEventDefinition, Source extends CailSourceClass> = CailBaseFieldsFor<Definition, Source> & CailSuccessErrorConstraint<Definition> & CailKeyPrincipalConstraint<Definition>;
type CailBaseFieldsFor<Definition extends CailEventDefinition, Source extends CailSourceClass> = {
    [Field in Extract<CailRequiredFieldNames<Definition>, keyof CailLogFields<Source>>]-?: CailFieldValue<Definition, Source, Field>;
} & {
    [Field in Extract<CailOptionalFieldNames<Definition>, keyof CailLogFields<Source>>]?: CailFieldValue<Definition, Source, Field>;
};
type CailAllowedFieldNames<Definition extends CailEventDefinition> = CailRequiredFieldNames<Definition> | CailOptionalFieldNames<Definition>;
type CailSuccessErrorConstraint<Definition extends CailEventDefinition> = "terminal" extends CailAllowedFieldNames<Definition> ? "error_type" extends CailAllowedFieldNames<Definition> ? {
    terminal?: Exclude<CailTerminalFor<Definition>, {
        outcome: "ok";
    }>;
    error_type?: string;
} | {
    terminal: Extract<CailTerminalFor<Definition>, {
        outcome: "ok";
    }>;
    error_type?: never;
} : unknown : unknown;
type CailAuthenticatedPrincipalFields = Readonly<{
    type: "user" | "canary";
    subject: string;
}> | Readonly<{
    type: "app" | "service";
    subject?: never;
}>;
type CailKeyPrincipalConstraint<Definition extends CailEventDefinition> = "key_id" extends CailAllowedFieldNames<Definition> ? {
    key_id?: never;
} | {
    key_id: string;
    principal: CailAuthenticatedPrincipalFields;
} : unknown;
type CailEmitArguments<Definition extends CailEventDefinition, Source extends CailSourceClass> = CailRequiredFieldNames<Definition> extends never ? [fields?: CailFieldsFor<Definition, Source>] : [fields: CailFieldsFor<Definition, Source>];
export interface CailLogger<Catalog extends CailEventCatalog = CailEventCatalog, Source extends CailSourceClass = "tenant"> {
    emit<Event extends CailEventNameFor<Catalog, Source>>(event: Event, ...args: CailEmitArguments<Catalog[Event], Source>): void;
}
export declare function jsonLineSink(event: CailLogEvent): void;
export type CailWorkersLogEvent = Readonly<Record<string, CailLogAttributeValue>>;
export declare function toWorkersLogEvent(event: CailLogEvent): CailWorkersLogEvent;
export declare function workersStructuredSink(event: CailLogEvent): void;
export declare function createCailLogger<const Catalog extends CailEventCatalog, const Source extends CailSourceClass>(options: CailLoggerOptions<Catalog, Source>): CailLogger<Catalog, Source>;
export {};
//# sourceMappingURL=logger.d.ts.map