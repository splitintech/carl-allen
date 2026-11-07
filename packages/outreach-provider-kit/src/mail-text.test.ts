import { describe,it,expect } from 'vitest';
import { plainMailText } from './mail-text';
describe('inert mailbox body text',()=>{
 it('keeps readable paragraphs and entities while discarding executable markup and remote images',()=>{expect(plainMailText('<style>hidden</style><script>send()</script><p>Pricing &amp; details</p><img src="https://private.invalid" onerror="send()"><p>&#128075; Next</p>')).toBe('Pricing & details\n👋 Next');});
 it('retains literal angle brackets in plain text and bounds malformed numeric entities',()=>{expect(plainMailText('price <10 & more','text')).toBe('price <10 & more');expect(plainMailText('&#99999999999999;')).toBe('�');expect(plainMailText('a'.repeat(20000),'text')).toHaveLength(10000);});
});
