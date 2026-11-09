import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPromoDialogText,
  popupIntent,
  promoDismissIntent
} from '../popups';

test('ChatGPT pricing modal is recognised as a promo overlay', () => {
  const text =
    'Upgrade your plan Try Plus free for 1 month Personal Business Free ' +
    'Your current plan Ad supported Claim free offer Limited time No ads';
  assert.equal(isPromoDialogText(text), true);
  assert.equal(isPromoDialogText('We use cookies to improve your experience.'), false);
  assert.equal(isPromoDialogText(''), false);
});

test('feature announcements, including GIF ones, are recognised', () => {
  assert.equal(isPromoDialogText('Now you can make GIFs with ChatGPT'), true);
  assert.equal(isPromoDialogText('Create GIFs from a few photos'), true);
  assert.equal(isPromoDialogText("What's new in ChatGPT"), true);
  assert.equal(isPromoDialogText('Introducing a new feature'), true);
  assert.equal(isPromoDialogText('GIFs are here'), true);
  assert.equal(isPromoDialogText('I like GIFs'), false);
});

test('localised promo text is matched after ASCII folding', () => {
  assert.equal(isPromoDialogText('Ofert\u0103 special\u0103 \u0219i reducere'), true);
  assert.equal(isPromoDialogText('Abonament lunar'), true);
  assert.equal(isPromoDialogText('Discu\u021bie obi\u0219nuit\u0103'), false);
});

test('promo dismissal accepts only close-style controls', () => {
  assert.equal(promoDismissIntent('Close pricing'), true);
  assert.equal(promoDismissIntent('Close'), true);
  assert.equal(promoDismissIntent('Dismiss'), true);
  assert.equal(promoDismissIntent('Not now'), true);
  assert.equal(promoDismissIntent('No, thanks'), true);
  assert.equal(promoDismissIntent('Maybe later'), true);
  assert.equal(promoDismissIntent('Stay on free plan'), true);
  assert.equal(promoDismissIntent('Got it'), true);
  assert.equal(promoDismissIntent('OK'), true);
  assert.equal(promoDismissIntent('\u00cenchide'), true);
  assert.equal(promoDismissIntent('Nu mul\u021bumesc'), true);
  assert.equal(promoDismissIntent('Mai t\u00e2rziu'), true);
});

test('promo dismissal never clicks the purchase CTA', () => {
  assert.equal(promoDismissIntent('Claim free offer'), false);
  assert.equal(promoDismissIntent('Upgrade'), false);
  assert.equal(promoDismissIntent('Buy Plus'), false);
  assert.equal(promoDismissIntent('Subscribe'), false);
  assert.equal(promoDismissIntent('See all plans'), false);
  assert.equal(promoDismissIntent(''), false);
});

test('consent matcher still ignores close / offer buttons', () => {
  assert.equal(popupIntent('Close pricing'), 0);
  assert.equal(popupIntent('Free offer'), 0);
  assert.equal(popupIntent('Claim free offer'), 0);
});
