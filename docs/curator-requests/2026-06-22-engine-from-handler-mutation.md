# Engine Request: Handler-Result Mutation Source

The installed `@simodelne/pgas-server@2.13.1` mutation schema accepts only
literal `value` and LLM-supplied `from_arg` sources. `pgas-new` needs a public
way for deterministic handler output to update governed state without asking the
LLM to supply that value.

Interim workaround: Phase 3 stores synthesized program YAML in an in-process
session-scoped Map inside the foundry server. Downstream handlers read from that
transit store, and `write_scaffold_artifacts` writes the YAML to
`<target_dir>/src/programs/<slug>/specs.yml`, where it becomes a first-class
artifact record.

Proper fix: allow action-map mutations to declare a handler-result source, for
example:

```yaml
mutations:
  - { op: MSet, path: program.synthesized_spec_json, from_handler: spec_yaml }
```

The engine would apply that mutation from the handler result key after the
handler returns successfully, preserving deterministic synthesis while keeping
state mutation governed by the spec.
