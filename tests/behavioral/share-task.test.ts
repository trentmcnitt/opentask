import { describe, expect, test } from 'vitest'
import { quotaShareWords, shareMoment, stripMachineLines, taskShareText } from '@/lib/share-task'

/**
 * The text a Share hands over (`src/lib/share-task.ts`): the title, the
 * deadline and the picked target when there, the notes without their machine
 * lines. Every string here is invented.
 */
const TZ = 'America/Chicago'
const NOW = new Date('2026-11-18T18:00:00Z')

const task = (over: Partial<Parameters<typeof taskShareText>[0]> = {}) => ({
  title: 'Synthetic fern voucher',
  notes: null,
  due_at: null,
  deadline_at: null,
  rrule: null,
  progress_target: 1,
  ...over,
})

describe('taskShareText', () => {
  test('SH-01: a bare task is its title', () => {
    expect(taskShareText(task(), TZ, NOW)).toBe('Synthetic fern voucher')
  })

  test('SH-02: deadline, then the picked target, then the notes', () => {
    const text = taskShareText(
      task({
        deadline_at: '2026-11-20T23:00:00Z',
        due_at: '2026-11-19T15:30:00Z',
        notes: 'Ask about the teal one.\nSecond line.',
      }),
      TZ,
      NOW,
    )
    expect(text).toBe(
      'Synthetic fern voucher\nDeadline Fri Nov 20, 5:00 PM\nTarget Thu Nov 19, 9:30 AM\n\nAsk about the teal one.\nSecond line.',
    )
  })

  test('SH-03: an automatic target and the queue mark are not the user’s: no Target line', () => {
    const auto = task({ due_at: '2026-11-19T15:00:00Z', target_auto: true })
    const marked = task({ due_at: '2026-11-19T15:00:00Z', queue_mark: true })
    expect(taskShareText(auto, TZ, NOW)).toBe('Synthetic fern voucher')
    expect(taskShareText(marked, TZ, NOW)).toBe('Synthetic fern voucher')
  })

  test('SH-04: a reminder shares title and notes only', () => {
    const text = taskShareText(
      task({ is_reminder: true, due_at: '2026-11-19T13:00:00Z', notes: 'Bring the lantern.' }),
      TZ,
      NOW,
    )
    expect(text).toBe('Synthetic fern voucher\n\nBring the lantern.')
  })

  test('SH-05: a quota says its count and period', () => {
    const quota = task({ is_tracked: true, progress_target: 2, rrule: 'FREQ=WEEKLY' })
    expect(taskShareText(quota, TZ, NOW)).toBe('Synthetic fern voucher\n2 a week')
    expect(quotaShareWords({ progress_target: 1, rrule: 'FREQ=WEEKLY;INTERVAL=2' })).toBe(
      '1 every 2 weeks',
    )
    expect(quotaShareWords({ progress_target: 3, rrule: 'FREQ=DAILY' })).toBe('3 a day')
  })

  test('SH-06: another year’s date carries its year', () => {
    expect(shareMoment('2027-01-04T15:00:00Z', TZ, NOW)).toBe('Mon Jan 4 2027, 9:00 AM')
  })

  test('SH-07: notes that were only machine lines add nothing', () => {
    const text = taskShareText(task({ notes: '[relay fetch <abc123@example.test>]' }), TZ, NOW)
    expect(text).toBe('Synthetic fern voucher')
  })
})

describe('stripMachineLines', () => {
  test('SH-10: a bracketed command with a reference goes, on its own line or closing one', () => {
    expect(stripMachineLines('Call back.\n[relay fetch <abc123@example.test>]')).toBe('Call back.')
    expect(stripMachineLines('Call back.  [relay fetch sms:9f8e7d]')).toBe('Call back.')
    expect(stripMachineLines('[relay fetch <a+b=c@example.test>]\n\nCall back.')).toBe('Call back.')
  })

  test('SH-11: a key line and a program’s signature go', () => {
    const notes = [
      'They wrote: "Thursday works."',
      'Made by the parcel desk. Do not edit below.',
      'desk-relay: thread=sms:+15550100 #sms:ab12cd34',
    ].join('\n')
    expect(stripMachineLines(notes)).toBe('They wrote: "Thursday works."')
    expect(stripMachineLines('desk-relay: message=ab12cd34ef56')).toBe('')
  })

  test('SH-12: what a person writes stays', () => {
    const notes = [
      '[x] buy twine',
      '[draft]',
      'follow-up: call back',
      'see [the blue folder] first',
      'ratio 3:1 [roughly]',
      'Made by the lake last summer',
      'key=value pairs are fine',
    ].join('\n')
    expect(stripMachineLines(notes)).toBe(notes)
  })

  test('SH-13: blank runs left behind are tidied', () => {
    expect(stripMachineLines('One.\n\n[relay fetch <a@example.test>]\n\nTwo.\n')).toBe(
      'One.\n\nTwo.',
    )
  })
})
