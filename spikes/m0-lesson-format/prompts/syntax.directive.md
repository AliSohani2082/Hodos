# Block syntax: Markdown directives

Prose is CommonMark Markdown. Blocks are directives.

Three shapes:

- Inline block, inside a sentence: `:name[the text]{attr=value}`
- Leaf block, which has no body, on its own line: `::name{attr=value}`
- Container block, which wraps Markdown. An opening line `:::name{attr=value}`, the Markdown body, then a closing line `:::`:

  ```
  :::name{attr=value}
  Markdown body.
  :::
  ```

  Containers can nest. The outer fence must have more colons than any container inside it, for example `::::outer` around `:::inner`. Close each container with a line of at least as many colons as it opened with.

Attributes:

- Write a simple value bare (`kind=mcq`) or in quotes when it has spaces (`caption="White to move"`). `#p1` is shorthand for `id=p1`. A value cannot contain a line break.
- There are no backslash escapes. To put a double quote inside a value, wrap the value in single quotes (`caption='He said "hi"'`) or write `&quot;`. A backslash is just a backslash.
- Numbers and booleans are written bare: `durationSec=20`, `correct=true`.
- Attributes take simple text, number and boolean values only. Anything structured (lists, objects) and any long text goes in a fenced yaml block, the first thing inside the container:

  ````
  :::name{attr=value}
  ```yaml
  field: value
  list: [a, b]
  object: {key: value}
  ```
  :::
  ````

  A leaf directive has no body, so a block that needs structured fields is written as a container with the yaml block. A block with no structured fields to give can use the leaf form.
- In yaml, quote any string that contains a colon followed by a space or a space followed by `#`, or that starts with one of `[ { * & ! | > % @ "` or a backtick. Inside `[ ]` and `{ }`, quote any string that contains a comma. Use `key: [a, b]` for short lists and `- {k: v}` items for lists of objects.
- Do not use `{% %}` tags. They do not exist in lessons.

Nesting: a container that holds child containers (for example `step` inside `worked-example`) uses the extra-colon rule above. An exercise has no child directives: its question, choices and hints are fields in its yaml block.

Code samples: fenced code blocks are always literal, including any `:::` or `{% %}` in them. Inline code spans (backticks) are always literal too.
