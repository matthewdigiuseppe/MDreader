// ¦ stands in for a backtick so the text can live in a template literal.
window.WELCOME_DOC = String.raw`---
title: Welcome to MDreader
author: You
date: today
---

# Welcome to MDreader

MDreader is a quiet place to **read and edit markdown**, built for academic work and the drafts, notes and reports that AI tools produce. Like Typora, it hides the markup: everything looks typeset until you click into a block, which then shows its raw markdown so you can edit it. Click away and it renders again.

> [!TIP] Try it
> Click on this paragraph. Press **Enter** to start a new block, **Esc** to stop editing, and **↑ / ↓** to move between blocks.

## What it understands

Regular *emphasis*, **strong**, ~~strikethrough~~, ==highlights==, ¦inline code¦, [links](https://commonmark.org), H~2~O and x^2^, plus inline math like $\hat{\beta} = (X^\top X)^{-1} X^\top y$ and display equations:

$$
\operatorname{logit}(p_i) = \alpha + \beta_1 \text{democracy}_i + \beta_2 \log(\text{GDP}_i) + \varepsilon_i
$$

Pandoc-style citations stay readable [@fearon1995; @schultz2001, p. 12]. Load your ¦.bib¦ (**File → Load bibliography**, or put one next to the document) and they become “(Fearon 1995; Schultz 2001, p. 12)”, with the full reference on hover and a reference list at the end. Keys that aren’t in your bibliography turn red, so citations an AI invented stand out. Footnotes show their text on hover.[^fn]

> [!NOTE] Live reload
> When another program changes the open file (Claude Code, an R script, ¦git pull¦), MDreader reloads it in place and marks the paragraphs that changed.

| Model        | Coef. |  S.E. |    N |
|:-------------|------:|------:|-----:|
| Baseline     | 0.412 | 0.087 | 2,314 |
| + Controls   | 0.367 | 0.091 | 2,190 |
| Fixed effects| 0.298 | 0.104 | 2,190 |

- Task lists you can tick:
  - [x] Draft the introduction
  - [ ] Check robustness tables
- Ordered and nested lists
- Code blocks with highlighting:

¦¦¦r
m <- glm(war ~ democracy + log(gdp), family = binomial, data = dyads)
summary(m)
¦¦¦

## Shortcuts

| Action | Shortcut |
|:--|:--|
| Bold / italic / code / link | Ctrl+B / Ctrl+I / Ctrl+E / Ctrl+K |
| Heading 1–6, paragraph | Ctrl+1 … Ctrl+6, Ctrl+0 |
| New block / line break inside a block | Enter / Shift+Enter |
| Leave a code or math block | Ctrl+Enter |
| Source mode (the whole file as plain text) | Ctrl+/ |
| Focus mode / typewriter mode | F8 / F9 |
| Open / save / save as | Ctrl+O / Ctrl+S / Ctrl+Shift+S |
| Load a bibliography (.bib) | Ctrl+Shift+B |
| Undo / redo across blocks | Ctrl+Z / Ctrl+Shift+Z |
| Open a link | Ctrl+click |

Drop a ¦.md¦ file anywhere on the window to open it. Your work is kept as a draft in this browser between visits, but use **Save** to write it to disk.

[^fn]: Footnote definitions render at the spot where you write them, and their numbers follow the order of the references.
`.replace(/¦/g, '`');
