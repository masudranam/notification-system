/**
 * Generates a VAPID keypair for Web Push.
 *
 * VAPID (RFC 8292) is how you authenticate to a browser's push service without any vendor
 * account: you own the keypair, the public half goes to the browser when it subscribes, and the
 * private half signs each push request. Run once, then paste the output into .env.
 *
 * Changing the keys later invalidates every existing subscription — browsers bind a subscription
 * to the applicationServerKey it was created with, so all previously registered devices will start
 * returning 403 and need to re-subscribe.
 */
import * as webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log('Add these to your .env file:\n');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`VAPID_SUBJECT=mailto:you@example.com`);
console.log(
  '\nNote: regenerating these invalidates every existing push subscription — ' +
    'registered devices will need to subscribe again.',
);
