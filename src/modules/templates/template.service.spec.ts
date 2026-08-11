import mjml2html from 'mjml';
import { assertDirectivesSurvived, htmlToText } from './template.service';
import { TEMPLATE_SEEDS } from '../../../prisma/seeds/templates';

const compile = mjml2html as unknown as (
  input: string,
  options?: { validationLevel?: 'strict' | 'soft' | 'skip' },
) => { html: string; errors: unknown[] };

/**
 * These tests exist because MJML silently discards Handlebars directives placed between
 * components, and the resulting emails look *almost* right — a loop body rendered once with blank
 * variables, or a conditional button rendered unconditionally with an empty href. Nothing throws,
 * so only an assertion catches it.
 */
describe('MJML + Handlebars interaction', () => {
  describe('assertDirectivesSurvived', () => {
    it('passes when every directive survives compilation', () => {
      const source = '<mj-raw>{{#if x}}</mj-raw><mj-text>hi</mj-text><mj-raw>{{/if}}</mj-raw>';
      expect(() => assertDirectivesSurvived('t1', source, source)).not.toThrow();
    });

    it('throws when MJML drops directives', () => {
      expect(() => assertDirectivesSurvived('t1', '{{#each items}}<x/>{{/each}}', '<x/>')).toThrow(
        /dropped 2 Handlebars directive/,
      );
    });

    it('does not throw when the compiler adds unrelated markup', () => {
      expect(() =>
        assertDirectivesSurvived('t1', '{{#if x}}{{/if}}', '<table>{{#if x}}{{/if}}</table>'),
      ).not.toThrow();
    });
  });

  describe('bare vs mj-raw wrapped directives', () => {
    const wrap = (inner: string) =>
      `<mjml><mj-body><mj-section><mj-column>${inner}</mj-column></mj-section></mj-body></mjml>`;

    it('loses directives written as bare text between components', () => {
      const html = compile(wrap('{{#each items}}<mj-text>{{this.name}}</mj-text>{{/each}}'), {
        validationLevel: 'soft',
      }).html;
      expect(html).not.toContain('{{#each items}}');
    });

    it('preserves directives wrapped in mj-raw', () => {
      const html = compile(
        wrap(
          '<mj-raw>{{#each items}}</mj-raw><mj-text>{{this.name}}</mj-text><mj-raw>{{/each}}</mj-raw>',
        ),
        { validationLevel: 'soft' },
      ).html;
      expect(html).toContain('{{#each items}}');
      expect(html).toContain('{{/each}}');
    });

    describe('angle-bracketed tag names inside Handlebars comments', () => {
      // The HTML parser runs before Handlebars, so `{{!-- ... --}}` is not a comment to it — any
      // `<tag>` inside is read as real markup.
      //
      // The damaging case is naming the component the comment sits inside: the phantom open tag
      // nests, the element's real closing tag closes *that* one instead, and the outer element is
      // left open to absorb and discard every sibling after it. This is the bug that silently
      // deleted the "Track your package" button from the order.shipped template.
      it('discards following siblings when the comment names its own enclosing component', () => {
        const html = compile(
          wrap(
            '<mj-table><tr><td>c</td></tr>{{!-- see <mj-table> --}}</mj-table>' +
              '<mj-button href="#">Btn</mj-button>',
          ),
          { validationLevel: 'soft' },
        ).html;
        expect(html).not.toContain('Btn');
      });

      it('also breaks inside mj-text naming mj-text', () => {
        const html = compile(
          wrap('<mj-text>{{!-- see <mj-text> --}}</mj-text><mj-button href="#">Btn</mj-button>'),
          { validationLevel: 'soft' },
        ).html;
        expect(html).not.toContain('Btn');
      });

      it('is harmless when the comment names a different component', () => {
        const html = compile(
          wrap('<mj-text>{{!-- see <mj-table> --}}</mj-text><mj-button href="#">Btn</mj-button>'),
          { validationLevel: 'soft' },
        ).html;
        expect(html).toContain('Btn');
      });
    });
  });

  describe('every seeded EMAIL template', () => {
    const emailTemplates = TEMPLATE_SEEDS.filter((t) => t.channel === 'EMAIL');

    it('has at least one email template to check', () => {
      expect(emailTemplates.length).toBeGreaterThan(0);
    });

    it.each(emailTemplates.map((t) => [t.topicKey, t] as const))(
      '%s survives MJML compilation with all directives intact',
      (_key, template) => {
        const result = compile(template.body, { validationLevel: 'soft' });
        expect(() =>
          assertDirectivesSurvived(template.topicKey, template.body, result.html),
        ).not.toThrow();
      },
    );

    it.each(emailTemplates.map((t) => [t.topicKey, t] as const))(
      '%s has balanced Handlebars blocks after compilation',
      (_key, template) => {
        const html = compile(template.body, { validationLevel: 'soft' }).html;
        const opens = (html.match(/\{\{#(?:if|unless|each|with)[^}]*\}\}/g) ?? []).length;
        const closes = (html.match(/\{\{\/(?:if|unless|each|with)\}\}/g) ?? []).length;
        // Unbalanced blocks make Handlebars.compile throw at render time, i.e. at send time.
        expect(closes).toBe(opens);
      },
    );
  });
});

describe('htmlToText', () => {
  it('keeps link targets that would otherwise vanish with the tags', () => {
    expect(htmlToText('<a href="https://example.com/x">Click</a>')).toBe(
      'Click (https://example.com/x)',
    );
  });

  it('strips style and head blocks entirely', () => {
    expect(htmlToText('<head><title>t</title></head><style>a{color:red}</style><p>Body</p>')).toBe(
      'Body',
    );
  });

  it('decodes the common HTML entities', () => {
    expect(htmlToText('<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>')).toBe('a & b <c> "d"');
  });

  it('collapses runs of blank lines', () => {
    expect(htmlToText('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb');
  });
});
