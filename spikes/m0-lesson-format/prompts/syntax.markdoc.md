# Block syntax: Markdoc

Prose is CommonMark Markdown. Blocks are Markdoc tags.

Three shapes:

- Inline block, inside a sentence: `{% name attr="value" %}the text{% /name %}`
- Container block, which wraps Markdown. The opening and closing tags each sit on their own line:

  ```
  {% name attr="value" %}
  Markdown body.
  {% /name %}
  ```

- Leaf block, which has no body. It closes itself with `/%}`: `{% name attr="value" /%}`

Attributes:

- Strings go in double quotes: `attr="text"`. Inside a string, write `\"` for a double quote and `\\` for a backslash. A string cannot contain a line break.
- Numbers and booleans are written bare: `level=1`, `correct=true`.
- Arrays use square brackets and objects use braces, and they nest: `skills=[{id: "a.b", weight: 1, role: "target"}]`. Object keys are bare words; string values are quoted.
- A tag's attributes may continue over several lines before the closing `%}`.
- Do not use variables (`$x`), functions, or tags such as `{% if %}`. They do not exist in lessons.

Nesting: every opening tag needs its closing tag, closed in reverse order. Child tags such as `step` sit inside their container on their own lines.

Exercises: an exercise holds its question and answers as child tags. `{% prompt %}...{% /prompt %}` holds the question. Each `{% choice id="a" %}...{% /choice %}` is one answer, and may hold a `{% feedback %}...{% /feedback %}` child. Each `{% hint level=1 %}...{% /hint %}` is one hint. Each `{% step id="s1" %}...{% /step %}` is one solution step. Everything else about the exercise is an attribute of the opening tag.

Code samples: inside a fenced code block, Markdoc still reads `{% ... %}`. If a code sample contains literal `{% ... %}`, add `{% process=false %}` after the language on the opening fence, like this:

````
```jinja {% process=false %}
{% if user %}Hello{% endif %}
```
````

Inline code spans (backticks) are always literal.
