import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseEmail, parseEmailList, splitTokens } from '../public/js/emails.js';

const D = 'education.nsw.gov.au';
const n = (s) => normaliseEmail(s).email;

describe('normaliseEmail', () => {
  test('appends the school domain to a bare name', () => {
    assert.equal(n('john.smith'), `john.smith@${D}`);
  });

  test('handles names carrying a number', () => {
    assert.equal(n('john.smith2'), `john.smith2@${D}`);
    assert.equal(n('sarah.lee14'), `sarah.lee14@${D}`);
  });

  test('does NOT append the domain twice to a full address', () => {
    assert.equal(n(`john.smith@${D}`), `john.smith@${D}`);
    assert.equal(n(`john.smith@${D}`).split('@').length, 2);
  });

  test('keeps a different domain as typed', () => {
    assert.equal(n('a.teacher@otherschool.edu.au'), 'a.teacher@otherschool.edu.au');
    assert.equal(n('someone@gmail.com'), 'someone@gmail.com');
  });

  test('trims whitespace and lowercases', () => {
    assert.equal(n('  John.Smith  '), `john.smith@${D}`);
    assert.equal(n('JOHN.SMITH@EDUCATION.NSW.GOV.AU'), `john.smith@${D}`);
  });

  test('John.Smith and john.smith are the same person', () => {
    assert.equal(n('John.Smith '), n('john.smith'));
  });

  test('extracts from "Display Name <addr>"', () => {
    assert.equal(n('John Smith <john.smith@education.nsw.gov.au>'), `john.smith@${D}`);
  });

  test('strips spreadsheet quoting and trailing punctuation', () => {
    assert.equal(n('"john.smith"'), `john.smith@${D}`);
    assert.equal(n('john.smith,'), `john.smith@${D}`);
  });

  test('flags obviously broken input as invalid rather than saving it', () => {
    assert.equal(normaliseEmail('a@@b.com').valid, false);
    assert.equal(normaliseEmail('someone@nodomain').valid, false);
    assert.equal(normaliseEmail('').valid, false);
  });

  test('a bare name always produces a valid address', () => {
    assert.equal(normaliseEmail('john.smith').valid, true);
  });
});

describe('splitTokens / parseEmailList', () => {
  test('splits on commas', () => {
    assert.deepEqual(parseEmailList('a,b,c').map((r) => r.email),
      [`a@${D}`, `b@${D}`, `c@${D}`]);
  });

  test('splits on semicolons, spaces, newlines and tabs together', () => {
    const got = parseEmailList('a; b\nc\td,e').map((r) => r.email);
    assert.deepEqual(got, [`a@${D}`, `b@${D}`, `c@${D}`, `d@${D}`, `e@${D}`]);
  });

  test('handles a mixed paste of bare names and full addresses', () => {
    const blob = `john.smith
sarah.lee14@education.nsw.gov.au
  peter.nguyen3 , peter.nguyen3
a.teacher@otherschool.edu.au`;
    assert.deepEqual(parseEmailList(blob).map((r) => r.email), [
      `john.smith@${D}`,
      `sarah.lee14@${D}`,
      `peter.nguyen3@${D}`,
      'a.teacher@otherschool.edu.au',
    ]);
  });

  test('drops duplicates silently, including case-different ones', () => {
    const got = parseEmailList('john.smith, John.Smith, JOHN.SMITH@education.nsw.gov.au');
    assert.equal(got.length, 1);
  });

  test('respects already-present addresses when deduping', () => {
    const got = parseEmailList('john.smith, sarah.lee', D, [`john.smith@${D}`]);
    assert.deepEqual(got.map((r) => r.email), [`sarah.lee@${D}`]);
  });

  test('keeps "Name <addr>" groups intact despite the internal space', () => {
    const got = parseEmailList('John Smith <john.smith@education.nsw.gov.au>, sarah.lee');
    assert.deepEqual(got.map((r) => r.email), [`john.smith@${D}`, `sarah.lee@${D}`]);
  });

  test('ignores empty tokens and stray separators', () => {
    assert.deepEqual(parseEmailList(' , ;;  \n\n , ').map((r) => r.email), []);
  });

  test('a realistic spreadsheet column paste', () => {
    const blob = 'john.smith\r\nsarah.lee14\r\npeter.nguyen3\r\n';
    assert.equal(parseEmailList(blob).length, 3);
  });

  test('splitTokens does not lose the last token without a trailing separator', () => {
    assert.equal(splitTokens('a,b,c').length, 3);
  });
});
