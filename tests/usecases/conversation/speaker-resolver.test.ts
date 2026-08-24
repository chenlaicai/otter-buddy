import { describe, it, expect } from 'vitest';
import { resolveSpeakerName } from '@usecases/conversation/speaker-resolver';

describe('resolveSpeakerName', () => {
  it('should return null for user sender type', () => {
    expect(resolveSpeakerName('user', 'user-id', 'Alice')).toBeNull();
  });

  it('should return null for system sender type', () => {
    expect(resolveSpeakerName('system', 'system-id', 'System')).toBeNull();
  });

  it('should return otter name when provided and non-empty', () => {
    expect(resolveSpeakerName('otter', 'otter-id', '大獭')).toBe('大獭');
  });

  it('should return senderId when otter name is null', () => {
    expect(resolveSpeakerName('otter', 'otter-id-123', null)).toBe('otter-id-123');
  });

  it('should return senderId when otter name is undefined', () => {
    expect(resolveSpeakerName('otter', 'otter-id-456', undefined)).toBe('otter-id-456');
  });

  it('should return senderId when otter name is empty string', () => {
    expect(resolveSpeakerName('otter', 'otter-id-789', '')).toBe('otter-id-789');
  });

  it('should return senderId when otter name is whitespace only', () => {
    expect(resolveSpeakerName('otter', 'otter-id-abc', '   ')).toBe('otter-id-abc');
  });

  it('should trim whitespace from otter name', () => {
    expect(resolveSpeakerName('otter', 'otter-id', '  大獭  ')).toBe('大獭');
  });
});
