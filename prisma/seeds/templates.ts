import { Channel } from '@prisma/client';

/**
 * Seed templates.
 *
 * EMAIL bodies are MJML, compiled to responsive table-based HTML at render time. Writing raw
 * email HTML by hand means hand-writing nested tables and Outlook conditionals; MJML generates
 * that for you.
 *
 * Every other channel takes plain text (Handlebars only). SLACK uses Slack's mrkdwn dialect —
 * note `<url|label>` links rather than markdown's `[label](url)`.
 *
 * `{{{triple}}}` braces mean "do not HTML-escape". Used only for the unsubscribe URL we build
 * ourselves; all producer-supplied values stay double-braced so a malicious payload cannot
 * inject markup into an email.
 *
 * ---------------------------------------------------------------------------------------------
 * IMPORTANT: Handlebars block helpers between MJML components must be wrapped in `<mj-raw>`.
 *
 * The render pipeline compiles MJML to HTML first, then runs Handlebars over the result (see
 * TemplateService). MJML's parser only keeps text that lives *inside* a component's content — a
 * bare `{{#each items}}` sitting between two `<mj-text>` elements is a text node child of
 * `<mj-column>`, and MJML silently discards it.
 *
 * The failure mode is nasty because it is silent and asymmetric: the opening and closing markers
 * vanish, so the loop body renders exactly once with every variable undefined, and a
 * `{{#if url}}`-guarded button renders unconditionally with `href=""`. Nothing errors.
 *
 * `<mj-raw>` content is emitted verbatim, so the directives survive to the Handlebars pass.
 * Handlebars *inside* a component's content (`<mj-text>`, `<mj-table>`) needs no wrapper.
 * ---------------------------------------------------------------------------------------------
 */
export interface TemplateSeed {
  topicKey: string;
  channel: Channel;
  locale: string;
  version: number;
  subject?: string;
  body: string;
}

/** Shared MJML chrome so every email looks like it came from the same system. */
function emailLayout(inner: string, opts: { showUnsubscribe?: boolean } = {}): string {
  const unsubscribe = opts.showUnsubscribe
    ? `
      <mj-text align="center" font-size="12px" color="#8a8f98" padding-top="16px">
        You are receiving this because you subscribed to updates.<br />
        <a href="{{{unsubscribeUrl}}}" style="color:#8a8f98;text-decoration:underline;">Unsubscribe</a>
      </mj-text>`
    : '';

  return `<mjml>
  <mj-head>
    <mj-title>{{subjectPreview}}</mj-title>
    <mj-attributes>
      <mj-all font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" />
      <mj-text font-size="15px" color="#1f2328" line-height="1.6" />
      <mj-button background-color="#2563eb" color="#ffffff" border-radius="6px" font-size="15px" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#f5f6f8">
    <mj-section padding="24px 0 8px">
      <mj-column>
        <mj-text align="center" font-size="18px" font-weight="600" color="#2563eb">Notify</mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="#ffffff" border-radius="8px" padding="8px 8px 24px">
      <mj-column>
${inner}
      </mj-column>
    </mj-section>
    <mj-section padding="8px 0 32px">
      <mj-column>${unsubscribe}
        <mj-text align="center" font-size="12px" color="#8a8f98">
          Sent by the notification-system learning project.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
}

export const TEMPLATE_SEEDS: TemplateSeed[] = [
  // ---------------------------------------------------------------- user.welcome
  {
    topicKey: 'user.welcome',
    channel: Channel.EMAIL,
    locale: 'en',
    version: 1,
    subject: 'Welcome aboard, {{name}}!',
    body: emailLayout(`        <mj-text font-size="22px" font-weight="600">Welcome, {{name}} 👋</mj-text>
        <mj-text>
          Your account is ready. You can manage which notifications you receive, and on which
          channels, at any time from your notification settings.
        </mj-text>
        <mj-raw>{{#if activationUrl}}</mj-raw>
        <mj-button href="{{activationUrl}}">Activate your account</mj-button>
        <mj-raw>{{/if}}</mj-raw>`),
  },
  {
    topicKey: 'user.welcome',
    channel: Channel.IN_APP,
    locale: 'en',
    version: 1,
    subject: 'Welcome aboard!',
    body: 'Hi {{name}}, your account is ready. Head to settings to choose how you want to be notified.',
  },
  // bn locale exists only for user.welcome, to exercise the locale fallback path.
  {
    topicKey: 'user.welcome',
    channel: Channel.IN_APP,
    locale: 'bn',
    version: 1,
    subject: 'স্বাগতম!',
    body: 'হ্যালো {{name}}, আপনার অ্যাকাউন্ট তৈরি হয়েছে।',
  },

  // ---------------------------------------------------------------- order.shipped
  {
    topicKey: 'order.shipped',
    channel: Channel.EMAIL,
    locale: 'en',
    version: 1,
    subject: 'Order {{orderId}} is on its way',
    body: emailLayout(`        <mj-text font-size="22px" font-weight="600">Your order shipped 📦</mj-text>
        <mj-text>
          Order <strong>{{orderId}}</strong> is with {{carrier}}.
          {{#if etaDate}}Estimated delivery: <strong>{{etaDate}}</strong>.{{/if}}
        </mj-text>
        <mj-text>Tracking number: <strong>{{trackingNumber}}</strong></mj-text>
        <mj-raw>{{#if items}}</mj-raw>
        <mj-table font-size="14px">
          <tr style="border-bottom:1px solid #e5e7eb;text-align:left;color:#6b7280;">
            <th style="padding:6px 0;">Item</th><th style="padding:6px 0;">Qty</th>
          </tr>
          {{!-- inside mj-table content, so no mj-raw wrapper is needed here.
                Never write an angle-bracketed tag name inside a Handlebars comment: MJML's HTML
                parser runs first and reads it as a real opening tag, silently nesting and
                discarding every sibling that follows. --}}
          {{#each items}}
          <tr><td style="padding:6px 0;">{{this.name}}</td><td style="padding:6px 0;">{{this.qty}}</td></tr>
          {{/each}}
        </mj-table>
        <mj-raw>{{/if}}</mj-raw>
        <mj-raw>{{#if trackingUrl}}</mj-raw>
        <mj-button href="{{trackingUrl}}">Track your package</mj-button>
        <mj-raw>{{/if}}</mj-raw>`),
  },
  {
    topicKey: 'order.shipped',
    channel: Channel.IN_APP,
    locale: 'en',
    version: 1,
    subject: 'Order {{orderId}} shipped',
    body: '{{carrier}} picked up your order. Tracking: {{trackingNumber}}.',
  },
  {
    topicKey: 'order.shipped',
    channel: Channel.PUSH,
    locale: 'en',
    version: 1,
    // Push titles are truncated aggressively by the OS — keep them under ~40 chars.
    subject: 'Order {{orderId}} shipped 📦',
    body: 'On its way with {{carrier}}. Tap to track.',
  },
  {
    topicKey: 'order.shipped',
    channel: Channel.SLACK,
    locale: 'en',
    version: 1,
    subject: 'Order shipped',
    body: '*Order {{orderId}}* shipped via {{carrier}}\n> Tracking: `{{trackingNumber}}`{{#if trackingUrl}}\n<{{trackingUrl}}|Track package>{{/if}}',
  },
  {
    topicKey: 'order.shipped',
    channel: Channel.SMS,
    locale: 'en',
    version: 1,
    // A single SMS segment is 160 GSM-7 chars; going over silently doubles the cost.
    body: 'Your order {{orderId}} shipped via {{carrier}}. Track: {{trackingNumber}}',
  },

  // ---------------------------------------------------------------- security.login_alert
  {
    topicKey: 'security.login_alert',
    channel: Channel.EMAIL,
    locale: 'en',
    version: 1,
    subject: 'New sign-in from {{location}}',
    body: emailLayout(`        <mj-text font-size="22px" font-weight="600">New sign-in detected 🔐</mj-text>
        <mj-text>
          Someone signed in to your account. If this was you, no action is needed.
        </mj-text>
        <mj-table font-size="14px">
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Location</td><td><strong>{{location}}</strong></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Device</td><td><strong>{{device}}</strong></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">IP address</td><td><strong>{{ipAddress}}</strong></td></tr>
          {{#if at}}<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Time</td><td><strong>{{at}}</strong></td></tr>{{/if}}
        </mj-table>
        <mj-raw>{{#if secureAccountUrl}}</mj-raw>
        <mj-button href="{{secureAccountUrl}}" background-color="#dc2626">This wasn't me — secure my account</mj-button>
        <mj-raw>{{/if}}</mj-raw>`),
  },
  {
    topicKey: 'security.login_alert',
    channel: Channel.IN_APP,
    locale: 'en',
    version: 1,
    subject: 'New sign-in from {{location}}',
    body: 'A new sign-in was detected on {{device}} ({{ipAddress}}). If this was not you, secure your account.',
  },
  {
    topicKey: 'security.login_alert',
    channel: Channel.PUSH,
    locale: 'en',
    version: 1,
    subject: 'New sign-in detected 🔐',
    body: '{{device}} from {{location}}. Tap if this was not you.',
  },

  // ---------------------------------------------------------------- product.newsletter
  {
    topicKey: 'product.newsletter',
    channel: Channel.EMAIL,
    locale: 'en',
    version: 1,
    subject: '{{headline}}',
    // The only template with an unsubscribe footer: it is the only MARKETING topic.
    body: emailLayout(
      `        <mj-text font-size="22px" font-weight="600">{{headline}}</mj-text>
        <mj-text>{{body}}</mj-text>
        <mj-raw>{{#if ctaUrl}}</mj-raw>
        <mj-button href="{{ctaUrl}}">{{#if ctaLabel}}{{ctaLabel}}{{else}}Read more{{/if}}</mj-button>
        <mj-raw>{{/if}}</mj-raw>`,
      { showUnsubscribe: true },
    ),
  },
  {
    topicKey: 'product.newsletter',
    channel: Channel.IN_APP,
    locale: 'en',
    version: 1,
    subject: '{{headline}}',
    body: '{{body}}',
  },

  // ---------------------------------------------------------------- comment.mentioned
  {
    topicKey: 'comment.mentioned',
    channel: Channel.EMAIL,
    locale: 'en',
    version: 1,
    subject: '{{authorName}} mentioned you',
    body: emailLayout(`        <mj-text font-size="22px" font-weight="600">{{authorName}} mentioned you</mj-text>
        <mj-text font-style="italic" color="#4b5563">"{{excerpt}}"</mj-text>
        <mj-raw>{{#if threadUrl}}</mj-raw>
        <mj-button href="{{threadUrl}}">View thread</mj-button>
        <mj-raw>{{/if}}</mj-raw>`),
  },
  {
    topicKey: 'comment.mentioned',
    channel: Channel.IN_APP,
    locale: 'en',
    version: 1,
    subject: '{{authorName}} mentioned you',
    body: '"{{excerpt}}"',
  },
  {
    topicKey: 'comment.mentioned',
    channel: Channel.PUSH,
    locale: 'en',
    version: 1,
    subject: '{{authorName}} mentioned you',
    body: '{{excerpt}}',
  },

  // ---------------------------------------------------------------- digest
  // Rendered by the digest flush job, which passes { count, items: [{ subject, body }] }.
  {
    topicKey: 'system.digest',
    channel: Channel.EMAIL,
    locale: 'en',
    version: 1,
    subject: 'Your {{window}} summary: {{count}} update{{#unless isSingular}}s{{/unless}}',
    body: emailLayout(
      `        <mj-text font-size="22px" font-weight="600">Your {{window}} summary</mj-text>
        <mj-text>You have {{count}} update{{#unless isSingular}}s{{/unless}} waiting.</mj-text>
        <mj-raw>{{#each items}}</mj-raw>
        <mj-text padding-bottom="4px"><strong>{{this.subject}}</strong></mj-text>
        <mj-text padding-top="0" color="#4b5563">{{this.body}}</mj-text>
        <mj-divider border-width="1px" border-color="#eef0f3" padding="8px 0" />
        <mj-raw>{{/each}}</mj-raw>`,
      { showUnsubscribe: true },
    ),
  },
  {
    topicKey: 'system.digest',
    channel: Channel.IN_APP,
    locale: 'en',
    version: 1,
    subject: 'Your {{window}} summary',
    body: '{{count}} updates waiting.',
  },
];
