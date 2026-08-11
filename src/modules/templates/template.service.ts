import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Channel } from '@prisma/client';
import * as Handlebars from 'handlebars';
import mjml2html from 'mjml';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * `@types/mjml-core` declares mjml2html as returning a Promise, but mjml v4 is synchronous — it
 * returns `{ html, json, errors }` directly. The published types are simply wrong. Wrapping the
 * cast here keeps the lie in one place instead of sprinkling `await`s that would silently work on
 * a non-thenable and hide the mismatch.
 */
type MjmlResult = { html: string; errors: Array<{ formattedMessage: string }> };
const compileMjml = mjml2html as unknown as (
  input: string,
  options?: { validationLevel?: 'strict' | 'soft' | 'skip'; minify?: boolean },
) => MjmlResult;

export interface RenderedMessage {
  subject?: string;
  /** HTML for EMAIL, plain text everywhere else. */
  body: string;
  /** Plain-text alternative, EMAIL only. */
  text?: string;
  templateVersion: number;
}

interface CompiledTemplate {
  subject?: HandlebarsTemplateDelegate;
  body: HandlebarsTemplateDelegate;
  /** Pre-compiled MJML output with placeholders still intact (EMAIL only). */
  version: number;
}

/**
 * Renders a (topic, channel, locale) template against a data payload.
 *
 * Two things worth understanding here:
 *
 * 1. **Compile order for email.** MJML is compiled to HTML *first*, then Handlebars runs over the
 *    resulting HTML. Doing it the other way round means user data flows into the MJML compiler,
 *    where a stray `<mj-` fragment in a payload could alter the document structure.
 *
 * 2. **Caching.** MJML compilation costs tens of milliseconds — far too slow to repeat per email.
 *    Templates are immutable (a change is a new `version` row), so the compiled form can be
 *    cached forever under a key that includes the version.
 */
@Injectable()
export class TemplateService {
  private readonly logger = new Logger(TemplateService.name);
  private readonly cache = new Map<string, CompiledTemplate>();

  constructor(private readonly prisma: PrismaService) {
    this.registerHelpers();
  }

  private registerHelpers() {
    // Handlebars ships with no comparison or formatting helpers at all.
    Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
    Handlebars.registerHelper('gt', (a: number, b: number) => a > b);
    Handlebars.registerHelper('json', (value: unknown) => JSON.stringify(value));
    Handlebars.registerHelper('upper', (v: unknown) => String(v ?? '').toUpperCase());
    Handlebars.registerHelper('truncate', (value: unknown, length: number) => {
      const str = String(value ?? '');
      return str.length <= length ? str : `${str.slice(0, Math.max(0, length - 1))}…`;
    });
  }

  /**
   * Picks the best template for a channel.
   *
   * Locale falls back to 'en' rather than failing: a missing Bengali template should still send an
   * English notification. Silence is a worse outcome than a wrong language.
   */
  async render(
    topicKey: string,
    channel: Channel,
    locale: string,
    data: Record<string, unknown>,
  ): Promise<RenderedMessage> {
    const template = await this.resolveTemplate(topicKey, channel, locale);
    const compiled = this.compile(template);

    const subject = compiled.subject?.(data)?.trim();
    // `subjectPreview` feeds the <mj-title> tag, so the email's own subject shows in the preview
    // pane of clients that render it.
    const body = compiled.body({ ...data, subjectPreview: subject ?? '' });

    if (channel !== Channel.EMAIL) {
      return { subject, body: body.trim(), templateVersion: compiled.version };
    }

    return {
      subject,
      body,
      text: htmlToText(body),
      templateVersion: compiled.version,
    };
  }

  private async resolveTemplate(topicKey: string, channel: Channel, locale: string) {
    const candidates = await this.prisma.template.findMany({
      where: { topicKey, channel, isActive: true, locale: { in: [locale, 'en'] } },
      orderBy: [{ version: 'desc' }],
    });

    if (candidates.length === 0) {
      throw new NotFoundException(
        `No active template for topic "${topicKey}" on channel ${channel} (locale ${locale})`,
      );
    }

    // Exact locale wins at any version; otherwise the highest-version English template.
    const exact = candidates.find((c) => c.locale === locale);
    const chosen = exact ?? candidates[0];
    if (!exact) {
      this.logger.debug(
        `Locale fallback: ${topicKey}/${channel} requested "${locale}", using "${chosen.locale}"`,
      );
    }
    return chosen;
  }

  private compile(template: {
    id: string;
    version: number;
    channel: Channel;
    subject: string | null;
    body: string;
  }): CompiledTemplate {
    const cacheKey = `${template.id}:${template.version}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    let bodySource = template.body;

    if (template.channel === Channel.EMAIL) {
      const result = compileMjml(bodySource, {
        validationLevel: 'soft',
        // Keep the output compact; email clients don't care about readable HTML.
        minify: false,
      });
      if (result.errors.length > 0) {
        // `soft` validation still produces usable HTML, so warn rather than fail the send.
        this.logger.warn(
          `MJML warnings for template ${template.id}: ${result.errors
            .map((e) => e.formattedMessage)
            .join('; ')}`,
        );
      }
      assertDirectivesSurvived(template.id, bodySource, result.html);
      bodySource = result.html;
    }

    const compiled: CompiledTemplate = {
      subject: template.subject
        ? Handlebars.compile(template.subject, { noEscape: true })
        : undefined,
      body: Handlebars.compile(bodySource),
      version: template.version,
    };
    this.cache.set(cacheKey, compiled);
    return compiled;
  }

  /** Test/preview helper — renders without persisting anything. */
  async preview(topicKey: string, channel: Channel, locale: string, data: Record<string, unknown>) {
    return this.render(topicKey, channel, locale, data);
  }
}

/** Matches Handlebars block open/close/else markers: {{#if}}, {{/each}}, {{else}}. */
const BLOCK_MARKER = /\{\{[#/](?:if|unless|each|with)[^}]*\}\}|\{\{else\}\}/g;

/**
 * Guards against MJML silently eating Handlebars directives.
 *
 * MJML only preserves text inside a component's content. A `{{#each}}` placed *between*
 * components is a text node child of `<mj-column>` and gets discarded — and so does an
 * angle-bracketed tag name written inside a `{{!-- comment --}}`, because the HTML parser runs
 * first and treats it as real markup, nesting every following sibling out of existence.
 *
 * Both failures are silent and destructive: the markers vanish, so a loop body renders once with
 * undefined variables and an `{{#if url}}`-guarded button renders unconditionally with `href=""`.
 * Nothing throws, and the broken email goes out looking almost right.
 *
 * Comparing the marker count either side of compilation turns that into a loud error at render
 * time. Wrap directives in `<mj-raw>` to fix it.
 */
export function assertDirectivesSurvived(
  templateId: string,
  mjmlSource: string,
  compiledHtml: string,
): void {
  const before = (mjmlSource.match(BLOCK_MARKER) ?? []).length;
  const after = (compiledHtml.match(BLOCK_MARKER) ?? []).length;

  if (after < before) {
    throw new Error(
      `Template ${templateId}: MJML compilation dropped ${before - after} Handlebars ` +
        `directive(s) (${before} before, ${after} after). Wrap block helpers that sit between ` +
        `MJML components in <mj-raw>, and remove any angle-bracketed tag names from ` +
        `{{!-- comments --}}.`,
    );
  }
}

/**
 * Minimal HTML-to-text for the multipart alternative.
 *
 * Every email should carry a text/plain part: some clients prefer it, screen readers use it, and
 * spam filters score HTML-only mail worse. This does not need to be a full converter — it needs
 * to be readable.
 */
export function htmlToText(html: string): string {
  return (
    html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<head[\s\S]*?<\/head>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      // Keep link targets, which are invisible once tags are stripped.
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .trim()
  );
}
