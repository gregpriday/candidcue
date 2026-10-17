import { describe, expect, it } from 'vitest';
import {
  CAPS_RUN_WORDS,
  LONG_PARAGRAPH_WORDS,
  LONG_SENTENCE_WORDS,
  VERY_LONG_PARAGRAPH_WORDS,
  lintScriptSource,
  type ScriptLintCode,
  type ScriptLintFinding,
} from '../../../src/control/lib/script-lint';

const POOL = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo',
  'foxtrot', 'golf', 'hotel', 'india', 'juliet',
];

/** `count` lowercase spoken words, broken into ten-word sentences. */
function prose(count: number): string {
  const sentences: string[] = [];
  let made = 0;
  while (made < count) {
    const take = Math.min(10, count - made);
    const words = Array.from({ length: take }, (_, i) => POOL[(made + i) % POOL.length]);
    sentences.push(`${words.join(' ')}.`);
    made += take;
  }
  return sentences.join(' ');
}

/** One sentence of `count` lowercase words, terminated. */
function oneSentence(count: number): string {
  return `${Array.from({ length: count }, (_, i) => POOL[i % POOL.length]).join(' ')}.`;
}

function codes(findings: ScriptLintFinding[]): ScriptLintCode[] {
  return findings.map((f) => f.code);
}

function only(findings: ScriptLintFinding[], code: ScriptLintCode): ScriptLintFinding[] {
  return findings.filter((f) => f.code === code);
}

describe('prose helper', () => {
  // The threshold assertions below are only meaningful if the fixture builder
  // produces exactly the word count it claims.
  it('produces the requested number of spoken words', () => {
    for (const n of [1, 10, 45, 46, 80, 81, 140, 141]) {
      expect(prose(n).split(/\s+/).filter(Boolean).length).toBe(n);
      expect(oneSentence(n).split(/\s+/).filter(Boolean).length).toBe(n);
    }
  });
});

describe('lintScriptSource', () => {
  it('returns nothing for an empty document', () => {
    expect(lintScriptSource('')).toEqual([]);
    expect(lintScriptSource('\n\n\n')).toEqual([]);
    expect(lintScriptSource('   \n\t\n')).toEqual([]);
  });

  it('stays quiet on ordinary well-formed prose', () => {
    const source = [
      '# A section',
      '',
      'Hi there. If you are reading this off the screen, that is the idea.',
      '',
      'Keep going at whatever pace feels natural, and watch what the text does.',
      '',
      '[Cue: relax your shoulders]',
      '',
    ].join('\n');
    expect(lintScriptSource(source)).toEqual([]);
  });
});

describe('long-paragraph', () => {
  it('does not fire at exactly the threshold and does fire one word past it', () => {
    expect(codes(lintScriptSource(prose(LONG_PARAGRAPH_WORDS)))).toEqual([]);

    const over = only(lintScriptSource(prose(LONG_PARAGRAPH_WORDS + 1)), 'long-paragraph');
    expect(over).toHaveLength(1);
    expect(over[0]!.severity).toBe('info');
    expect(over[0]!.message).toContain(String(LONG_PARAGRAPH_WORDS + 1));
  });

  it('escalates to warn only past the second threshold', () => {
    const at = only(lintScriptSource(prose(VERY_LONG_PARAGRAPH_WORDS)), 'long-paragraph');
    expect(at).toHaveLength(1);
    expect(at[0]!.severity).toBe('info');

    const past = only(lintScriptSource(prose(VERY_LONG_PARAGRAPH_WORDS + 1)), 'long-paragraph');
    expect(past).toHaveLength(1);
    expect(past[0]!.severity).toBe('warn');
  });

  it('explains the recovery cost rather than restating the word count', () => {
    const [finding] = only(lintScriptSource(prose(120)), 'long-paragraph');
    expect(finding!.message).toMatch(/end of the sentence/i);
    expect(finding!.message).toMatch(/bounded[\s\S]*by the paragraph/i);
    expect(finding!.message).toMatch(/read one twice|skip a line/i);
    expect(finding!.hint).toMatch(/blank line|split/i);
  });

  it('spans the paragraph from its first word to its last', () => {
    const source = `Lead in.\n\n${prose(90)}\n`;
    const [finding] = only(lintScriptSource(source), 'long-paragraph');
    expect(finding!.line).toBe(3);
    expect(finding!.column).toBe(1);
    // The range runs from the first spoken word to the end of the last one —
    // the closing full stop is not a word, so it sits outside.
    const start = source.indexOf(POOL[0]!, source.indexOf('\n\n'));
    const end = source.lastIndexOf('.');
    expect(finding!.length).toBe(end - start);
    expect(source.slice(start + finding!.length!, end + 1)).toBe('.');
  });

  it('counts a paragraph split across several authored lines as one paragraph', () => {
    const wrapped = `${prose(50)}\n${prose(50)}\n`;
    expect(codes(lintScriptSource(wrapped))).toContain('long-paragraph');

    const separated = `${prose(50)}\n\n${prose(50)}\n`;
    expect(codes(lintScriptSource(separated))).not.toContain('long-paragraph');
  });

  it('does not count link destinations as spoken words', () => {
    // 76 authored words plus a three-word link label is under the threshold;
    // the five tokens hiding in the URL would push it over.
    const source = `${prose(76)} [read the docs](https://example.com/deep/path/here).\n`;
    expect(codes(lintScriptSource(source))).toEqual([]);
  });
});

describe('very-long-sentence', () => {
  it('does not fire at exactly the threshold and does fire one word past it', () => {
    expect(codes(lintScriptSource(oneSentence(LONG_SENTENCE_WORDS)))).toEqual([]);

    const over = only(lintScriptSource(oneSentence(LONG_SENTENCE_WORDS + 1)), 'very-long-sentence');
    expect(over).toHaveLength(1);
    expect(over[0]!.message).toContain(String(LONG_SENTENCE_WORDS + 1));
  });

  it('points at the offending sentence, not the paragraph', () => {
    const source = `Short opener.\n\n${oneSentence(3)} ${oneSentence(60)}\n`;
    const [finding] = only(lintScriptSource(source), 'very-long-sentence');
    expect(finding!.line).toBe(3);
    // The long sentence starts after "alpha bravo charlie. ".
    expect(finding!.column).toBe(oneSentence(3).length + 2);
  });

  it('does not split a sentence on an abbreviation, so one long sentence stays one', () => {
    const body = `${Array.from({ length: 60 }, (_, i) => POOL[i % POOL.length]).join(' ')}`;
    const source = `Dr. ${body} etc.\n`;
    const findings = only(lintScriptSource(source), 'very-long-sentence');
    expect(findings).toHaveLength(1);
  });
});

describe('all-caps-run', () => {
  it('fires at exactly four consecutive capitalised words, not three', () => {
    expect(codes(lintScriptSource('Now listen. ALPHA BRAVO CHARLIE and back.'))).toEqual([]);

    const findings = only(
      lintScriptSource('Now listen. ALPHA BRAVO CHARLIE DELTA and back.'),
      'all-caps-run',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain(String(CAPS_RUN_WORDS));
  });

  it('reports the run position and extent against the original source', () => {
    const source = 'Now listen. ALPHA BRAVO CHARLIE DELTA and back.';
    const [finding] = only(lintScriptSource(source), 'all-caps-run');
    expect(finding!.line).toBe(1);
    expect(finding!.column).toBe(source.indexOf('ALPHA') + 1);
    expect(finding!.length).toBe('ALPHA BRAVO CHARLIE DELTA'.length);
  });

  it('treats single-letter and caseless words as neither evidence nor a break', () => {
    // "I" and "2026" carry no authorial choice of case, so they must not hide
    // a run and must not manufacture one.
    expect(codes(lintScriptSource('So I SAID STOP I MEAN IT now.'))).toContain('all-caps-run');
    expect(codes(lintScriptSource('So I saw 2026 and A plan today.'))).not.toContain('all-caps-run');
  });

  it('measures a run that straddles an authored line break', () => {
    const findings = only(lintScriptSource('ALPHA BRAVO\nCHARLIE DELTA now.'), 'all-caps-run');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(1);
    expect(findings[0]!.length).toBe('ALPHA BRAVO\nCHARLIE DELTA'.length);
  });

  it('exempts authored cues, whether they own the line or sit inside one', () => {
    expect(lintScriptSource('[Cue: LOOK AT THE LENS NOW]\n')).toEqual([]);
    expect(
      codes(lintScriptSource('Say this now [Cue: LOOK AT THE LENS NOW] and carry on.')),
    ).not.toContain('all-caps-run');
  });

  it('stays silent on writing systems that have no capitals to shout in', () => {
    // Japanese, Arabic, Hebrew and Thai letters are neither upper nor lower
    // case. Measuring the run by letters instead of by capitals called every
    // word of these shouted and told the author to "use sentence case here",
    // which is not a thing their script can do.
    expect(codes(lintScriptSource('こんにちは 世界 今日 天気 です ね.'))).not.toContain('all-caps-run');
    expect(codes(lintScriptSource('مرحبا بالعالم اليوم الطقس جميل جدا.'))).not.toContain('all-caps-run');
    expect(codes(lintScriptSource('שלום עולם היום מזג האוויר.'))).not.toContain('all-caps-run');
    expect(codes(lintScriptSource('สวัสดี ชาว โลก วันนี้ อากาศ ดี.'))).not.toContain('all-caps-run');
  });

  it('still hears capitals outside the ASCII range', () => {
    expect(codes(lintScriptSource('Voici. ÉCOLE ÉTÉ ÉLÈVE ÉPÉE et voilà.'))).toContain('all-caps-run');
    expect(codes(lintScriptSource('Слушай. АЛЬФА БРАВО ЧАРЛИ ДЕЛЬТА и всё.'))).toContain('all-caps-run');
  });

  it('exempts headings and inline code', () => {
    expect(lintScriptSource('# ALPHA BRAVO CHARLIE DELTA\n')).toEqual([]);
    expect(
      codes(lintScriptSource('Look at `const ALPHA BRAVO CHARLIE DELTA = 1` here.')),
    ).not.toContain('all-caps-run');
  });
});

describe('no-terminal-punctuation', () => {
  it('accepts every mark the display and the aligner key off', () => {
    for (const ending of ['.', '?', '!', ':']) {
      expect(lintScriptSource(`This paragraph ends properly${ending}\n`)).toEqual([]);
    }
  });

  it('accepts a terminator behind a closing quote or bracket', () => {
    expect(lintScriptSource('She said "we are done."\n')).toEqual([]);
    expect(lintScriptSource('And then (that was that.)\n')).toEqual([]);
    expect(lintScriptSource('It ended *right here.*\n')).toEqual([]);
  });

  it('fires on a paragraph with no terminator and points at its last word', () => {
    const source = 'This one just stops\n';
    const findings = only(lintScriptSource(source), 'no-terminal-punctuation');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(1);
    expect(findings[0]!.column).toBe(source.indexOf('stops') + 1);
    expect(findings[0]!.length).toBe('stops'.length);
    expect(findings[0]!.severity).toBe('info');
  });

  it('exempts bullet lists, which are legitimately written without full stops', () => {
    const list = ['- first point', '- second point', '- third point', ''].join('\n');
    expect(codes(lintScriptSource(list))).not.toContain('no-terminal-punctuation');

    // A prose paragraph next to the list is still checked.
    const mixed = `${list}\nAnd then this trails off\n`;
    expect(codes(lintScriptSource(mixed))).toContain('no-terminal-punctuation');
  });
});

describe('skipped regions', () => {
  it('genuinely skips fenced code blocks', () => {
    const source = [
      '```js',
      'const shout = "ALPHA BRAVO CHARLIE DELTA";',
      `// ${prose(120)}`,
      'const trailing = 1',
      '```',
      '',
    ].join('\n');
    expect(lintScriptSource(source)).toEqual([]);
  });

  it('does not let a tilde fence be closed by a backtick fence', () => {
    const source = ['~~~', 'ALPHA BRAVO CHARLIE DELTA', '```', 'ECHO FOXTROT GOLF HOTEL', '~~~', ''].join('\n');
    expect(lintScriptSource(source)).toEqual([]);
  });

  it('genuinely skips cue and stage directive blocks', () => {
    for (const name of ['cue', 'stage', 'silent', 'literal-command']) {
      const source = [`:::${name}`, 'LOOK AT THE LENS NOW', prose(120), 'and no full stop', ':::', ''].join('\n');
      expect(lintScriptSource(source)).toEqual([]);
    }
  });

  it('resumes linting after a directive block closes', () => {
    const source = [':::cue', 'LOOK AT THE LENS NOW', ':::', '', 'This trails off', ''].join('\n');
    const findings = lintScriptSource(source);
    expect(codes(findings)).toEqual(['no-terminal-punctuation']);
    expect(findings[0]!.line).toBe(5);
  });

  it('stays quiet for the rest of the document when a directive block is never closed', () => {
    // An unclosed container is a script the author is midway through editing.
    // Silence is the right failure direction: the alternative is a burst of
    // findings about text that is about to become a directive body.
    const source = [':::stage', 'LOOK AT THE LENS NOW', '', 'This trails off', ''].join('\n');
    expect(lintScriptSource(source)).toEqual([]);
  });

  it('lints inside a blockquote, with the marker itself not a word', () => {
    const findings = lintScriptSource('> ALPHA BRAVO CHARLIE DELTA and stop\n');
    expect(codes(findings)).toEqual(['all-caps-run', 'no-terminal-punctuation']);
    expect(findings[0]!.column).toBe(3);
  });

  it('skips front matter, whether or not it carries a coach key', () => {
    const withCoach = ['---', 'coach:', '  style: calm', '---', '', 'All good here.', ''].join('\n');
    expect(lintScriptSource(withCoach)).toEqual([]);

    const withoutCoach = ['---', 'title: ALPHA BRAVO CHARLIE DELTA', '---', '', 'All good here.', ''].join('\n');
    expect(lintScriptSource(withoutCoach)).toEqual([]);
  });

  it('reads a leading byte-order mark as no part of line one (#247)', () => {
    const BOM = '\uFEFF';
    // A stage direction opening on line one stays out of the lint...
    const stage = [':::stage', 'LOOK AT THE LENS NOW', ':::', '', 'All good here.', ''].join('\n');
    expect(codes(lintScriptSource(BOM + stage))).not.toContain('all-caps-run');
    expect(lintScriptSource(BOM + stage)).toEqual(lintScriptSource(stage));
    // ...and so does front matter.
    const front = ['---', 'title: ALPHA BRAVO CHARLIE DELTA', '---', '', 'All good here.', ''].join('\n');
    expect(lintScriptSource(BOM + front)).toEqual([]);
    // Columns count from the editor's line start, which still holds the mark.
    const caps = 'ALPHA BRAVO CHARLIE DELTA and stop.\n';
    const [plain] = only(lintScriptSource(caps), 'all-caps-run');
    const [marked] = only(lintScriptSource(BOM + caps), 'all-caps-run');
    expect(marked!.line).toBe(1);
    expect(marked!.column).toBe(plain!.column! + 1);
    expect(marked!.length).toBe(plain!.length);
  });

  it('does not mistake an opening horizontal rule for front matter', () => {
    // `---`, prose, `---` is indistinguishable from front matter if you only
    // look at the first line, and guessing wrong silences an arbitrary span of
    // real script. A lint that has gone quiet looks exactly like a lint that
    // is happy, so this is the one wrong answer the author cannot catch.
    const source = ['---', '', 'This trails off', '', '---', '', 'And this one too'].join('\n');
    expect(lintScriptSource(source).map((f) => f.line)).toEqual([3, 7]);
  });

  it('skips a setext heading and the paragraph it retitles', () => {
    expect(lintScriptSource('ALPHA BRAVO CHARLIE DELTA\n=========\n')).toEqual([]);
    expect(lintScriptSource('Alpha bravo\nCHARLIE DELTA ECHO FOXTROT\n=====\n')).toEqual([]);

    // Underlined with dashes it is a level-two heading rather than a rule, so
    // the title goes quiet and only the prose beneath it is linted.
    const dashed = lintScriptSource('Alpha bravo\n-----\nAnd this trails off\n');
    expect(codes(dashed)).toEqual(['no-terminal-punctuation']);
    expect(dashed[0]!.line).toBe(3);
  });

  it('leaves a real rule alone and never retitles a bullet or a quote', () => {
    // The blank line closes the paragraph, so the dashes have nothing above
    // them to underline and stay a rule.
    expect(lintScriptSource('Alpha bravo.\n\n---\n\nCharlie delta.\n')).toEqual([]);
    expect(codes(lintScriptSource('- ALPHA BRAVO CHARLIE DELTA and stop\n=====\n'))).toContain(
      'all-caps-run',
    );
    expect(codes(lintScriptSource('> ALPHA BRAVO CHARLIE DELTA and stop\n=====\n'))).toContain(
      'all-caps-run',
    );
  });

  it('skips headings, tables, rules and comment directives', () => {
    const source = [
      '## ALPHA BRAVO CHARLIE DELTA',
      '',
      '| ALPHA BRAVO CHARLIE DELTA | ECHO |',
      '| --- | --- |',
      '| one | two |',
      '',
      '---',
      '',
      '<!-- cc:style calm -->',
      '',
    ].join('\n');
    expect(lintScriptSource(source)).toEqual([]);
  });
});

/*
 * A line that is only a bracket is silent only when the COMPILER says so.
 *
 * The lint used to skip every whole-line `[…]` as an annotation. A take aligns
 * against the app compiler's tokens, and that compiler speaks any bracket that
 * is not one of its directives — `[Todo: …]` is spoken, and the spoken-count
 * fixture pins it — so the lint was going quiet over words the presenter will
 * be followed through.
 */
describe('whole-line brackets', () => {
  it('still skips a line of recognised directives, one or several', () => {
    for (const line of ['[Beat]', '[Pause]', '[Breathe]', '[Take: Opening]', '[Pause] [Beat]', '[Cue: smile]  [Beat]']) {
      expect(lintScriptSource(`${line}\n`), line).toEqual([]);
    }
  });

  it('skips a malformed directive, which the compiler does not speak either', () => {
    expect(lintScriptSource('[Cue:]\n')).toEqual([]);
  });

  it('lints an unrecognised bracket on its own line as the words it is', () => {
    const findings = lintScriptSource('[Todo: tighten this opening]\n');
    expect(codes(findings)).toEqual(['no-terminal-punctuation']);
    expect(findings[0]!.line).toBe(1);
    expect(findings[0]!.column).toBe('[Todo: tighten this '.length + 1);

    expect(codes(lintScriptSource('[SOMEONE CHECK THIS FIGURE]\n'))).toContain('all-caps-run');
  });

  it('counts its words into the paragraph around it', () => {
    // Joined to the prose either side by single line breaks, so it is one
    // paragraph to the compiler and must be one paragraph here.
    const under = `${prose(LONG_PARAGRAPH_WORDS - 2)}\n[note to self]\n`;
    const findings = only(lintScriptSource(under), 'long-paragraph');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain(String(LONG_PARAGRAPH_WORDS + 1));
  });

  it('reads only what the compiler reads on a line it now lints', () => {
    // A footnote marker draws and speaks nothing; a reference link reads its
    // label and never its identifier. Both used to hide behind the old skip.
    expect(lintScriptSource('[^note]\n\n[^note]: A footnote.\n')).toEqual([]);
    const reference = lintScriptSource('[Continue.][FOUR WORDS IN REF]\n\n[four words in ref]: https://example.com\n');
    expect(codes(reference)).not.toContain('all-caps-run');
    expect(reference.filter((f) => f.line === 1)).toEqual([]);
    // Two directives back to back are still two cues, not a reference link.
    expect(lintScriptSource('[Pause][Beat]\n')).toEqual([]);
    expect(lintScriptSource('Say it [Pause][Beat] and go.\n')).toEqual([]);
  });

  it('reads an unresolved footnote or reference as the prose the compiler speaks', () => {
    // With no definition the parser resolves nothing: `[^…]` and `[a][b]` are
    // bracketed text, spoken word for word, so their words count here too.
    const footnote = lintScriptSource('Say [^ALPHA BRAVO CHARLIE DELTA] now.\n');
    expect(codes(footnote)).toContain('all-caps-run');
    const reference = lintScriptSource('Say [label][ALPHA BRAVO CHARLIE DELTA] now.\n');
    expect(codes(reference)).toContain('all-caps-run');
    // Defined, the same identifier is hidden again.
    const defined = lintScriptSource(
      'Say [label][ALPHA BRAVO CHARLIE DELTA] now.\n\n[alpha bravo charlie delta]: https://example.com\n',
    );
    expect(defined.filter((f) => f.line === 1 && f.code === 'all-caps-run')).toEqual([]);
  });

  it('treats a line that mixes a directive and an unknown bracket as prose', () => {
    // The directive is hidden, the unknown bracket is read.
    expect(codes(lintScriptSource('[Beat] [aside]\n'))).toEqual(['no-terminal-punctuation']);
    expect(lintScriptSource('[Beat] [aside].\n')).toEqual([]);
  });
});

describe('positions against the original source', () => {
  it('reports the right line when a paragraph follows a fenced code block', () => {
    const source = [
      '# Title',
      '',
      '```js',
      'const shout = "ALPHA BRAVO CHARLIE DELTA";',
      '```',
      '',
      'ALPHA BRAVO CHARLIE DELTA and then some more words here.',
      '',
    ].join('\n');
    const findings = only(lintScriptSource(source), 'all-caps-run');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(7);
    expect(findings[0]!.column).toBe(1);
  });

  it('reports the right line when a paragraph follows front matter and a heading', () => {
    const source = [
      '---',
      'coach:',
      '  style: calm',
      '---',
      '',
      '# Part one',
      '',
      'This one just stops',
      '',
    ].join('\n');
    const findings = lintScriptSource(source);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(8);
  });

  it('reports the same lines and columns for CRLF input', () => {
    const lines = ['# Title', '', '```js', 'const x = 1;', '```', '', 'Now listen. ALPHA BRAVO CHARLIE DELTA and stop'];
    const lf = lintScriptSource(`${lines.join('\n')}\n`);
    const crlf = lintScriptSource(`${lines.join('\r\n')}\r\n`);

    expect(codes(lf)).toEqual(['all-caps-run', 'no-terminal-punctuation']);
    expect(crlf.map((f) => ({ code: f.code, line: f.line, column: f.column, length: f.length })))
      .toEqual(lf.map((f) => ({ code: f.code, line: f.line, column: f.column, length: f.length })));
  });

  it('returns findings in document order', () => {
    const source = [
      'This first one just stops',
      '',
      prose(100),
      '',
      'ALPHA BRAVO CHARLIE DELTA and back.',
      '',
    ].join('\n');
    const findings = lintScriptSource(source);
    expect(findings.map((f) => f.line)).toEqual([...findings.map((f) => f.line)].sort((a, b) => a - b));
    expect(codes(findings)).toEqual(['no-terminal-punctuation', 'long-paragraph', 'all-caps-run']);
  });
});

describe('advisory contract', () => {
  it('never emits a severity above warn', () => {
    const source = [prose(300), '', 'ALPHA BRAVO CHARLIE DELTA ECHO no stop here'].join('\n');
    const findings = lintScriptSource(source);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(['info', 'warn']).toContain(finding.severity);
      expect(finding.message.length).toBeGreaterThan(0);
    }
  });
});
