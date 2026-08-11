import { countSegments, isE164, maskPhone } from './mock-sms.provider';

/**
 * SMS segment counting is a billing concern, not a cosmetic one: a single non-GSM-7 character
 * (a curly quote pasted from a document, an emoji) switches the whole message to UCS-2 and drops
 * the per-segment budget from 160 characters to 70, silently multiplying the cost.
 */
describe('countSegments', () => {
  it('counts a short GSM-7 message as one segment', () => {
    expect(countSegments('Hello world')).toEqual({ segments: 1, encoding: 'GSM-7' });
  });

  it('fits exactly 160 GSM-7 characters in one segment', () => {
    expect(countSegments('a'.repeat(160))).toEqual({ segments: 1, encoding: 'GSM-7' });
  });

  it('splits at 161 characters using the 153-septet concatenated limit', () => {
    // Concatenation costs 7 septets of UDH per part, hence 153 rather than 160.
    expect(countSegments('a'.repeat(161))).toEqual({ segments: 2, encoding: 'GSM-7' });
    expect(countSegments('a'.repeat(306))).toEqual({ segments: 2, encoding: 'GSM-7' });
    expect(countSegments('a'.repeat(307))).toEqual({ segments: 3, encoding: 'GSM-7' });
  });

  it('charges GSM-7 extension characters two septets each', () => {
    // 80 braces = 160 septets, still one segment; 81 tips it over.
    expect(countSegments('{'.repeat(80))).toEqual({ segments: 1, encoding: 'GSM-7' });
    expect(countSegments('{'.repeat(81))).toEqual({ segments: 2, encoding: 'GSM-7' });
  });

  it('switches to UCS-2 for a single non-GSM-7 character', () => {
    // The classic cost trap: one emoji in an otherwise plain message.
    const result = countSegments(`${'a'.repeat(70)}🎉`);
    expect(result.encoding).toBe('UCS-2');
    expect(result.segments).toBe(2);
  });

  it('fits 70 UCS-2 characters in one segment', () => {
    expect(countSegments('é🎉' + 'a'.repeat(68))).toEqual({ segments: 1, encoding: 'UCS-2' });
  });

  it('treats a curly quote as UCS-2, unlike a straight quote', () => {
    expect(countSegments("It's fine").encoding).toBe('GSM-7');
    expect(countSegments('It’s fine').encoding).toBe('UCS-2');
  });

  it('handles accented characters that ARE in the GSM-7 alphabet', () => {
    expect(countSegments('Café à Öl').encoding).toBe('GSM-7');
  });
});

describe('isE164', () => {
  it.each(['+8801700000001', '+14155552671', '+442071838750'])('accepts %s', (value) => {
    expect(isE164(value)).toBe(true);
  });

  it.each([
    ['01700000001', 'no leading +'],
    ['+0170000001', 'country code starts with 0'],
    ['+880 170 000', 'contains spaces'],
    ['+880-170-0000', 'contains dashes'],
    ['+1', 'too short'],
    ['+1234567890123456', 'more than 15 digits'],
    ['', 'empty'],
  ])('rejects %s (%s)', (value) => {
    expect(isE164(value)).toBe(false);
  });
});

describe('maskPhone', () => {
  it('never reveals the full number', () => {
    const masked = maskPhone('+8801700000001');
    expect(masked).not.toContain('1700000');
    expect(masked).toBe('+880****01');
  });

  it('leaves very short values alone rather than producing nonsense', () => {
    expect(maskPhone('+123')).toBe('+123');
  });
});
