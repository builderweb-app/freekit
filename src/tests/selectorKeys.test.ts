import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSlotName, slotFromRegistryKey } from '../selectorKeys';

test('normalizeSlotName accepts camelCase, kebab-case and snake_case', () => {
  assert.equal(normalizeSlotName('input'), 'input');
  assert.equal(normalizeSlotName('newChat'), 'newChat');
  assert.equal(normalizeSlotName('new-chat'), 'newChat');
  assert.equal(normalizeSlotName('new_chat'), 'newChat');
  assert.equal(normalizeSlotName('stop-button'), 'stopButton');
  assert.equal(normalizeSlotName('stop_button'), 'stopButton');
  assert.equal(normalizeSlotName('response'), 'response');
  assert.equal(normalizeSlotName('loggedOut'), null);
  assert.equal(normalizeSlotName(''), null);
  assert.equal(normalizeSlotName(null), null);
  assert.equal(normalizeSlotName(42), null);
});

test('registry keys for new-chat selectors map to newChat', () => {
  assert.equal(slotFromRegistryKey('chat.deepseek.com:new-chat'), 'newChat');
  assert.equal(slotFromRegistryKey('gemini.google.com:new-chat-button'), 'newChat');
  assert.equal(slotFromRegistryKey('chat.mistral.ai:a-href-work-temporary-chat'), 'newChat');
  assert.equal(slotFromRegistryKey('example.com:new_chat'), 'newChat');
});

test('registry keys for composer selectors map to input', () => {
  assert.equal(slotFromRegistryKey('chat.deepseek.com:textarea'), 'input');
  assert.equal(
    slotFromRegistryKey('claude.ai:div-prosemirror-contenteditable-true'),
    'input'
  );
  assert.equal(
    slotFromRegistryKey('gemini.google.com:rich-textarea-ql-editor-contenteditable-true'),
    'input'
  );
  assert.equal(slotFromRegistryKey('example.com:message-input'), 'input');
});

test('registry keys for response and stop selectors map to their slots', () => {
  assert.equal(slotFromRegistryKey('example.com:assistant-message'), 'response');
  assert.equal(slotFromRegistryKey('example.com:chat-response-message'), 'response');
  assert.equal(slotFromRegistryKey('example.com:model-response-text'), 'response');
  assert.equal(slotFromRegistryKey('example.com:message-content'), 'response');
  assert.equal(slotFromRegistryKey('example.com:stop-button'), 'stopButton');
});

test('ambiguous or opaque registry keys are not mapped', () => {
  assert.equal(slotFromRegistryKey('chat.deepseek.com:div-9a2f8e4'), null);
  assert.equal(slotFromRegistryKey('chat.deepseek.com:a-546d736-b64fb9ae'), null);
  assert.equal(
    slotFromRegistryKey('chat.deepseek.com:div-role-button-ds-button-ds-button-iconlabelter'),
    null
  );
  // Două sloturi în același slug => ambiguu, nu ghicim.
  assert.equal(slotFromRegistryKey('example.com:assistant-message-contenteditable'), null);
  assert.equal(slotFromRegistryKey(''), null);
  assert.equal(slotFromRegistryKey(null), null);
  assert.equal(slotFromRegistryKey(undefined), null);
});

test('only the part after the last colon is inspected', () => {
  assert.equal(slotFromRegistryKey('https://chat.deepseek.com:new-chat'), 'newChat');
  assert.equal(slotFromRegistryKey('new-chat'), 'newChat');
});
