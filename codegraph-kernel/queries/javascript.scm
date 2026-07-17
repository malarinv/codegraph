; Seed query for the R1 scaffold (JavaScript / JSX grammar) — smoke-level
; coverage only; R2 replaces this with the full port. See typescript.scm for
; the capture convention.

(class_declaration name: (identifier) @name) @def.class
(function_declaration name: (identifier) @name) @def.function
(generator_function_declaration name: (identifier) @name) @def.function
(method_definition name: (property_identifier) @name) @def.method

(call_expression function: (identifier) @ref.calls)
(call_expression function: (member_expression property: (property_identifier) @ref.calls))
(new_expression constructor: (identifier) @ref.instantiates)
