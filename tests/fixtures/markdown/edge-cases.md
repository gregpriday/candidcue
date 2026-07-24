Content before the first heading goes into a synthetic Opening section.

# Edge Cases

[Take: Retry]

Some text with an empty cue [Cue:] that is malformed.

[Take:]

[Todo: this is an unknown bracket note]

:::mystery
Unknown container directives stay visible as source.
:::

<div class="raw">Raw HTML must not pass through.</div>

<!-- This comment disappears entirely. -->

## Results

First results section.

## Results

Second section with the same name. Dr. Jones met J. K. Rowling at 3 p.m. and paid 1,250 dollars.

[Take: Retry]

CandidCue, jump to the end, please read this sentence naturally.

- [x] Ship the recorder
- [ ] Write the docs

An escaped \[Pause] and an entity &#91;Beat&#93; must stay ordinary text.

```markdown
:::spoken
visual: fenced
say: fenced
:::
[Take: InsideFence]
```

:::stage
Nested containers compose.

:::spoken
visual: v2.0
say: version two point oh
:::

:::

Unicode offsets survive an emoji 🎬 and an accent café mid-sentence.

The **Candid**Cue brand is one spoken word.
