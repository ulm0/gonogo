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
  it('says, on one line, how to reach a gonogo in a container from another device, with the port the host publishes', () => {
    const text = containerHint(7777, null);
    expect(text.split('\n').filter(Boolean)).toHaveLength(1);
    expect(text).toContain("open http://<this machine's address>:7777 from any device on your network");
    expect(text).toContain('GONOGO_ALLOWED_HOSTS');
    expect(containerHint(7777, null, { GONOGO_PUBLISHED_PORT: '8080' })).toContain(':8080 from any device');
    expect(containerHint(7777, null, { GONOGO_PUBLISHED_PORT: 'x; rm' })).toContain(':7777 from any device'); // only a port number is believed
    expect(containerHint(7777, null)).not.toMatch(/172\./);
  });
  it('with a public address named, it prints that one', () => {
    const text = containerHint(7777, 'https://gonogo.example.com/', { GONOGO_PUBLISHED_PORT: '8080' });
    expect(text).toContain('open https://gonogo.example.com from any device');
    expect(text).not.toContain('<this machine');
    expect(text.endsWith('\n')).toBe(true);
  });
});
