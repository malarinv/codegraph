; Seed query for the R1 scaffold — smoke-level coverage that proves the
; buffer contract and emitter mechanics end to end. NOT extraction parity:
; R2 replaces this with the full TypeScript/TSX port.
;
; Capture convention (see emitter.rs):
;   @def.<NodeKind>  — the declaration node; pairs with @name in the pattern
;   @name            — the declaration's name node
;   @ref.<EdgeKind>  — a reference; the capture's own text is the name

(class_declaration name: (type_identifier) @name) @def.class
(abstract_class_declaration name: (type_identifier) @name) @def.class
(interface_declaration name: (type_identifier) @name) @def.interface
(enum_declaration name: (identifier) @name) @def.enum
(type_alias_declaration name: (type_identifier) @name) @def.type_alias
(function_declaration name: (identifier) @name) @def.function
(generator_function_declaration name: (identifier) @name) @def.function
(method_definition name: (property_identifier) @name) @def.method

(call_expression function: (identifier) @ref.calls)
(call_expression function: (member_expression property: (property_identifier) @ref.calls))
(new_expression constructor: (identifier) @ref.instantiates)
