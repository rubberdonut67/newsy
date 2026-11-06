import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cookieDomain } from './util.ts';

test('cookieDomain reduces subdomains to the registrable domain', () => {
  assert.equal(cookieDomain('https://www.wsj.com/articles/x'), 'wsj.com');
  assert.equal(cookieDomain('https://login.wsj.com'), 'wsj.com');
  assert.equal(cookieDomain('myaccount.nytimes.com'), 'nytimes.com');
  assert.equal(cookieDomain('nytimes.com'), 'nytimes.com');
});

test('cookieDomain keeps the third label for compound suffixes', () => {
  assert.equal(cookieDomain('https://www.bbc.co.uk/news'), 'bbc.co.uk');
  assert.equal(cookieDomain('https://www.theguardian.co.uk'), 'theguardian.co.uk');
});

test('cookieDomain is case- and whitespace-insensitive', () => {
  assert.equal(cookieDomain('  HTTPS://WWW.FT.COM/Login '), 'ft.com');
});

test('cookieDomain rejects input that is not a host', () => {
  assert.equal(cookieDomain(''), '');
  assert.equal(cookieDomain('   '), '');
});
