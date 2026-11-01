// Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Bib = require('../js/bib.js');
const MD = require('../js/markdown.js');

const BIB = String.raw`
% A comment line
@string{apsr = "American Political Science Review"}

@article{fearon1995,
  author  = {Fearon, James D.},
  title   = {Rationalist Explanations for War},
  journal = {International Organization},
  year    = {1995},
  volume  = {49},
  number  = {3},
  pages   = {379--414},
  doi     = {10.1017/S0020818300033324}
}

@Article{fearon_laitin2003,
  author = {James D. Fearon and David D. Laitin},
  title = "Ethnicity, Insurgency, and Civil War",
  journal = apsr,
  year = 2003,
}

@book{gleditsch2002a, author={Gleditsch, Kristian Skrede}, title={All International Politics Is Local}, publisher={University of Michigan Press}, address={Ann Arbor}, year={2002}}
@article{gleditsch2002b, author={Gleditsch, Kristian Skrede}, title={Expanded Trade and GDP Data}, journal={Journal of Conflict Resolution}, year={2002}}
@article{many2010, author={M{\"u}ller, J{\"o}rg and Smith, Ann and Doe, Jo}, title={{The} {\&} Problem}, journal={J}, date={2010-05-01}}
@comment{ignored @article{nope, title={x}} }
`;

test('parses entries, @string macros and LaTeX accents', () => {
  const p = Bib.parse(BIB);
  assert.deepEqual(p.keys, ['fearon1995', 'fearon_laitin2003', 'gleditsch2002a', 'gleditsch2002b', 'many2010']);
  assert.equal(p.errors.length, 0);
  assert.equal(p.entries.fearon_laitin2003.fields.journal, 'American Political Science Review');
  assert.equal(p.entries.fearon1995.fields.pages, '379–414');
  assert.equal(p.entries.many2010.fields.author, 'Müller, Jörg and Smith, Ann and Doe, Jo');
  assert.equal(p.entries.many2010.fields.title, 'The & Problem');
});

test('names and author-date labels with disambiguation', () => {
  const lib = Bib.fromText(BIB);
  assert.deepEqual(lib.labels.fearon1995, { author: 'Fearon', year: '1995' });
  assert.deepEqual(lib.labels.fearon_laitin2003, { author: 'Fearon and Laitin', year: '2003' });
  assert.deepEqual(lib.labels.many2010, { author: 'Müller et al.', year: '2010' });
  assert.equal(lib.labels.gleditsch2002a.year, '2002a'); // "All International..." sorts first
  assert.equal(lib.labels.gleditsch2002b.year, '2002b');
  assert.deepEqual(Bib.parseNames('Ludwig van Beethoven'), [{ last: 'van Beethoven', first: 'Ludwig' }]);
});

test('parses pandoc citation syntax', () => {
  assert.deepEqual(Bib.parseCitation('see @doe99, pp. 33-35; also -@smith04'), [
    { prefix: 'see', suppress: false, key: 'doe99', suffix: 'pp. 33-35' },
    { prefix: 'also', suppress: true, key: 'smith04', suffix: '' },
  ]);
});

test('renders citations author-date and flags unknown keys', () => {
  const lib = Bib.fromText(BIB);
  const html = MD.renderDocument('As shown [see @fearon1995, p. 4; @fearon_laitin2003] and [@invented2021].', { bib: lib });
  assert.match(html, /\(see Fearon 1995, p\. 4; Fearon and Laitin 2003\)/);
  assert.match(html, /class="cite resolved missing" data-keys="invented2021" data-missing="invented2021">\(<span class="cite-key">@invented2021<\/span>\)/);
  assert.match(MD.renderDocument('[-@fearon1995]', { bib: lib }), /\(1995\)/);
});

test('in-text citations, without false positives', () => {
  const lib = Bib.fromText(BIB);
  const html = MD.renderDocument('@fearon1995 argues; @madeup2020 too. Mail me@x.com or ping @jack.', { bib: lib });
  assert.match(html, /Fearon \(1995\)<\/span> argues/);
  assert.match(html, /data-missing="madeup2020"/);
  assert.match(html, /me@x\.com/);
  assert.match(html, /ping @jack\./);
  // without a bibliography, bare @mentions are left alone
  assert.doesNotMatch(MD.renderDocument('@fearon1995 argues'), /cite/);
});

test('formats a full reference', () => {
  const lib = Bib.fromText(BIB);
  const ref = Bib.formatReference(lib.entries.fearon1995);
  assert.equal(
    ref,
    'Fearon, James D. 1995. “Rationalist Explanations for War.” <em>International Organization</em> 49 (3): 379–414. <a href="https://doi.org/10.1017/S0020818300033324">doi:10.1017/S0020818300033324</a>'
  );
  assert.match(Bib.formatReference(lib.entries.gleditsch2002a), /<em>All International Politics Is Local<\/em>\. Ann Arbor: University of Michigan Press\./);
});

test('reads bibliography paths from front matter', () => {
  assert.deepEqual(MD.frontMatterBibliography('---\ntitle: X\nbibliography: refs.bib\n---\n\nBody'), ['refs.bib']);
  assert.deepEqual(MD.frontMatterBibliography('---\nbibliography:\n  - a.bib\n  - "b.bib"\n---'), ['a.bib', 'b.bib']);
  assert.deepEqual(MD.frontMatterBibliography('---\nbibliography: [a.bib, b.bib]\n---'), ['a.bib', 'b.bib']);
  assert.deepEqual(MD.frontMatterBibliography('No front matter'), []);
});
