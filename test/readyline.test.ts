// The `gonogo ready:` line tells the address people are given, and in a container what to do about it.
import { describe, expect, it } from 'vitest';
import { containerHint, readyUrl } from '../src/server/cli.js';

describe('readyUrl', () => {
  it('is the address gonogo listens on, or the public one when it was named, with the token fragment kept', () => {
    expect(readyUrl('http://127.0.0.1:7777/#token=abc', null)).toBe('http://127.0.0.1:7777/#token=abc');
    expect(readyUrl('http://127.0.0.1:7777/#token=abc', 'https://gonogo.example.com')).toBe('https://gonogo.example.com/#token=abc');
    expect(readyUrl('http://127.0.0.1:7777/#token=abc', 'https://gonogo.example.com/')).toBe('https://gonogo.example.com/#token=abc');
    expect(readyUrl('http://127.0.0.1:7777/', 'http://192.168.1.5:7777')).toBe('http://192.168.1.5:7777/');
    // the setup line takes the part before the fragment
    expect(readyUrl('http://127.0.0.1:7777/', 'https://g.example.com').split('#')[0]?.replace(/\/$/, '')).toBe('https://g.example.com');
  });
});

describe('containerHint', () => {
  it('says, on one line, how to reach a gonogo in a container from another machine', () => {
    const text = containerHint(7777, null);
    expect(text.split('\n').filter(Boolean)).toHaveLength(1);
    expect(text).toContain("From another machine, open http://<this computer's address>:7777");
    expect(text).toContain('GONOGO_HOST in compose.yaml');
    expect(text).toContain('GONOGO_ALLOWED_HOSTS');
  });
  it('with a public address named, it says that one is the address and where it is allowed', () => {
    const text = containerHint(7777, 'https://gonogo.example.com');
    expect(text).toContain('https://gonogo.example.com');
    expect(text).not.toContain('<this computer');
    expect(text.endsWith('\n')).toBe(true);
  });
});
