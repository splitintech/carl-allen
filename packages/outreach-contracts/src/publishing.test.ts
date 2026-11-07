import { describe, expect, it } from 'vitest';
import { publishingFormatIssues } from './publishing';
describe('native publishing format matrix',()=>{
 it('requires media that matches the selected format',()=>{expect(publishingFormatIssues('linkedin','carousel',['image/png'])).toHaveLength(1);expect(publishingFormatIssues('instagram','carousel',['image/png','video/mp4'])).toHaveLength(1);expect(publishingFormatIssues('instagram','reel',['image/png'])).toHaveLength(1);expect(publishingFormatIssues('x','video',['video/webm'])).toHaveLength(1);expect(publishingFormatIssues('linkedin','carousel',Array(20).fill('image/jpeg'))).toEqual([]);expect(publishingFormatIssues('instagram','reel',['video/mp4'])).toEqual([]);});
 it('rejects native formats the selected platform does not implement',()=>{expect(publishingFormatIssues('tiktok','carousel',['image/png','image/png'])).toHaveLength(1);expect(publishingFormatIssues('linkedin','reel',['video/mp4'])).toHaveLength(1);expect(publishingFormatIssues('x','reel',['video/mp4'])).toHaveLength(1);expect(publishingFormatIssues('tiktok',undefined,['video/mp4'])).toEqual([]);});
});
