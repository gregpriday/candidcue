import { describe, expect, it } from 'vitest';
import { sessionCommandSchema, stageCommandSchema } from '@shared/schemas/ipc';

// The Zod schemas are a separate source of truth from the TS command unions:
// a dropped literal would still typecheck but reject the command at the IPC
// boundary. These guard the retake commands' runtime parse (#62).
describe('IPC command schemas — retake (#62)', () => {
  it('sessionCommandSchema accepts RETAKE_TURN', () => {
    expect(sessionCommandSchema.parse({ type: 'RETAKE_TURN' })).toEqual({ type: 'RETAKE_TURN' });
  });

  it('stageCommandSchema accepts RETAKE', () => {
    expect(stageCommandSchema.parse({ type: 'RETAKE' })).toEqual({ type: 'RETAKE' });
  });

  it('still rejects unknown command types', () => {
    expect(() => sessionCommandSchema.parse({ type: 'NOT_A_COMMAND' })).toThrow();
    expect(() => stageCommandSchema.parse({ type: 'NOT_A_COMMAND' })).toThrow();
  });
});
