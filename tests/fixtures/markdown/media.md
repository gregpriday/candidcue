# Media Handling

Here is a local diagram of the flow.

![Pipeline overview](assets/pipeline.png)

And a remote image that must not auto-load:

![Remote chart](https://example.com/chart.png)

| Metric | Before | After |
|---|---:|---:|
| Takes per video | 14 | 3 |
| Editing hours | 6 | 1.5 |

```mermaid
flowchart LR
  A[Voice] --> B[Alignment]
  B --> C[Stage]
```

```ts
const answer = 42;
```

Inline `code span` stays visual by default.

A reference image resolves through its definition: ![Reference chart][refimg]

An unsafe image reference must not become an asset: ![Danger](javascript:alert(1))

[refimg]: assets/reference.png
