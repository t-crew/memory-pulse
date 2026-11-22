# Measured: the bundled rule packs against public repositories

Read on 2026-11-21. Each pack was run with `memory-pulse pack check <pack> <repository>` over shallow clones of the repositories
below, as data (nothing in them was run or installed). A hit is **true** when the line uses the deprecated or removed thing the
rule names, and **false** when the line is something else or is a correct use (a version guard, a table of old names, the
vendor's own test of the old API). Every hit of every block rule was read. For a warn rule, **read** is how many hits were
read: all of them up to 12, a fixed-seed sample above that.

A rule blocks only when all of this holds: the vendor's page says removed or not supported; that is so in every version the
vendor still fixes bugs in; nothing restores it under the same name; the pattern is specific to it inside the rule's paths;
and the corpus shows no false hit. Everything else warns. A warn rule is shown to the agent and does not stop the edit.

| pack | rule | severity | hits | true | false | read | notes |
|---|---|---|---|---|---|---|---|
| python-stdlib | imp-module | warn | 3 | 2 | 1 | 3 | false: gevent imports it in an except ImportError fallback. Was block; downgraded |
| python-stdlib | distutils | warn | 305 | 0 | 12 | 12 | setuptools is the package that provides distutils, and 272 of the hits are its own |
| python-stdlib | asyncore-asynchat-smtpd | warn | 6 | 0 | 6 | 6 | all in gevent's copies of the CPython 3.10 and 3.11 test suites |
| python-stdlib | unittest-aliases | block | 336 | 336 | 0 | 336 | all in boto (archived, Python 2 era), each a call. Tightened: the failUnless and failIf names were dropped after 27 hits on Twisted trial, which defines methods of those names |
| python-stdlib | safeconfigparser | block | 0 | 0 | 0 | 0 | tightened to the lowercase configparser module after one hit on boto's Python 2 branch (from ConfigParser import ...) |
| python-stdlib | locale-format | block | 0 | 0 | 0 | 0 |  |
| python-stdlib | ssl-wrap-socket | block | 2 | 2 | 0 | 2 | both in boto. Tightened: test paths excluded after 21 hits in gevent's copies of the CPython 3.10 and 3.11 test_ssl |
| python-stdlib | datetime-utcnow | warn | 18 | 9 | 3 | 12 | false: one commented line, two in CPython's own datetime tests |
| python-stdlib | pep594-modules | warn | 9 | 3 | 6 | 9 | false: Twisted's guarded optional imports of crypt and spwd |
| python-stdlib | ast-constant-aliases | warn | 0 | 0 | 0 | 0 | was block; downgraded without a hit: version-guarded uses are plausible in tools that still parse for older Pythons |
| python-stdlib | pkgutil-loaders | block | 0 | 0 | 0 | 0 |  |
| python-stdlib | asyncio-iscoroutinefunction | warn | 0 | 0 | 0 | 0 |  |
| pydantic-v2 | basesettings-import | warn | 0 | 0 | 0 | 0 | was block; downgraded with the two below: a library that supports V1 and V2 imports it inside a guard |
| pydantic-v2 | generic-model | warn | 2 | 0 | 2 | 2 | openai-python's _compat.py, in its Pydantic V1 branch. Was block; downgraded |
| pydantic-v2 | root-field | warn | 1 | 0 | 1 | 1 | openai-python's V1 branch. Was block; downgraded |
| pydantic-v2 | validator-decorator | warn | 0 | 0 | 0 | 0 |  |
| pydantic-v2 | root-validator | warn | 1 | 0 | 1 | 1 | openai-python's V1 branch |
| pydantic-v2 | config-renamed-keys | warn | 0 | 0 | 0 | 0 |  |
| pydantic-v2 | field-renamed-arguments | warn | 0 | 0 | 0 | 0 |  |
| pydantic-v2 | deprecated-model-methods | warn | 5 | 0 | 5 | 5 | openai-python's V1 branch and its tests |
| pydantic-v2 | validate-arguments | warn | 0 | 0 | 0 | 0 |  |
| fastapi | on-event | warn | 14 | 12 | 0 | 12 | FastAPI's own tutorials for the deprecated form, and its tests of it |
| fastapi | param-regex | warn | 2 | 2 | 0 | 2 | FastAPI's tests of the deprecated argument |
| fastapi | param-example | warn | 4 | 1 | 3 | 4 | false: two docstring lines and one commented line |
| fastapi | json-response-classes | warn | 28 | 6 | 6 | 12 | false: the class names inside deprecation messages and docstrings |
| fastapi | wsgi-middleware | warn | 0 | 0 | 0 | 0 |  |
| fastapi | root-path-param | warn | 2 | 2 | 0 | 2 |  |
| fastapi | openapi-prefix | block | 0 | 0 | 0 | 0 |  |
| nextjs-app-router | pages-data-fetching | block | 0 | 0 | 0 | 0 |  |
| nextjs-app-router | next-router-import | block | 0 | 0 | 0 | 0 | tightened before measuring: import type is not matched |
| nextjs-app-router | next-head-import | warn | 1 | 1 | 0 | 1 |  |
| nextjs-app-router | sync-request-apis | warn | 4 | 4 | 0 | 4 | examples not yet moved to the async form |
| nextjs-app-router | revalidate-tag-single-argument | warn | 2 | 2 | 0 | 2 |  |
| nextjs-app-router | next-legacy-image | warn | 0 | 0 | 0 | 0 |  |
| cloudflare-workers | node-compat | block | 0 | 0 | 0 | 0 |  |
| cloudflare-workers | legacy-assets | block | 0 | 0 | 0 | 0 |  |
| cloudflare-workers | wrangler-publish | block | 0 | 0 | 0 | 0 |  |
| cloudflare-workers | usage-model | warn | 0 | 0 | 0 | 0 |  |
| cloudflare-workers | workers-sites | warn | 2 | 2 | 0 | 2 | workers-sdk fixtures for Workers Sites |
| cloudflare-workers | legacy-env | warn | 0 | 0 | 0 | 0 |  |
| cloudflare-workers | service-worker-syntax | warn | 9 | 6 | 3 | 9 | false: one comment and two strings that hold Worker source in tests |
| stripe | charges-create | warn | 11 | 1 | 10 | 11 | false: the SDKs' own tests of the Charges resource |
| stripe | sources-api | warn | 2 | 0 | 2 | 2 | the SDKs' own tests of the Sources resource. Tightened: customers.createSource is another API and is no longer matched (4 hits) |
| stripe | redirect-to-checkout | warn | 1 | 1 | 0 | 1 |  |
| stripe | handle-card-payment | warn | 0 | 0 | 0 | 0 |  |
| stripe | legacy-checkout-js | warn | 0 | 0 | 0 | 0 |  |
| supabase-auth | auth-helpers-packages | warn | 0 | 0 | 0 | 0 |  |
| supabase-auth | auth-session-user-v1 | warn | 0 | 0 | 0 | 0 |  |
| supabase-auth | auth-sign-in-v1 | warn | 0 | 0 | 0 | 0 |  |
| supabase-auth | auth-update-v1 | warn | 0 | 0 | 0 | 0 |  |
| llm-models | anthropic-retired-opus | warn | 12 | 0 | 10 | 10 | the SDK's own table of retired models, and migration maps in the cookbooks' validators. Was block; downgraded |
| llm-models | anthropic-retired-sonnet | warn | 24 | 3 | 7 | 10 | true: request examples and a default tier. False: tables, maps, one mock response. Was block; downgraded |
| llm-models | anthropic-retired-haiku | warn | 9 | 0 | 9 | 9 | tables and maps. Was block; downgraded |
| llm-models | anthropic-deprecated-sonnet-4-5 | warn | 74 | 0 | 10 | 10 | request and response fixtures in litellm's transformation code |
| llm-models | openai-shutdown-gpt-4 | warn | 100 | 1 | 9 | 10 | false: documentation examples, limit tables, a registry |
| llm-models | openai-shutdown-gpt-3.5 | warn | 67 | 1 | 9 | 10 | false: tokenizer lookups (token_counter(model=...)) and documentation examples |
| llm-models | openai-shutdown-older | warn | 17 | 0 | 10 | 10 | migration maps and tokenizer tables |
| llm-models | openai-deprecated | warn | 35 | 2 | 8 | 10 | true: a plugin's model registry. False: capacity tables and family checks |
| llm-models | google-shutdown-gemini-2.0 | warn | 3 | 0 | 3 | 3 | docstring examples |
| llm-models | google-shutdown-gemini-1.5 | warn | 2 | 0 | 2 | 2 | docstring examples |
| llm-models | google-deprecated-gemini-2.5 | warn | 24 | 3 | 7 | 10 | true: a default model and a test matrix. False: docstrings and family checks |

61 rules: 11 block, 50 warn.

## What the measurement changed

- **Downgraded from block to warn:** python-stdlib imp-module and ast-constant-aliases; pydantic-v2 basesettings-import,
  generic-model and root-field; and the retired Anthropic ids in llm-models (four rules then, three now). Reasons are in the notes column. A second attempt
  at the Anthropic ids matched only `model = "<id>"` and `"model": "<id>"`: 6 hits, 3 false (two response examples and one mock
  response carry the same key), so it was dropped and the ids warn wherever they are quoted.
- **Tightened:** unittest-aliases, safeconfigparser, ssl-wrap-socket, next-router-import, sources-api.
- **Paths:** the llm-models rules skip test folders, test files, `_next/` output and `*.min.js`.
- **llm-models reads mostly false here** because the corpus is SDKs, a gateway and cookbooks, which list model ids in tables on
  purpose. In an application the same id sits in a request. That is why the whole pack warns and none of it blocks.
- **supabase-auth had no hit**: the examples in supabase/supabase and the two applications have already moved to `@supabase/ssr`.
  Its rules rest on the vendor pages and their fixtures alone.

## Left out, and why

- `.dict()`, `.json()`, `.copy()`, `.construct()` and `class Config:` (Pydantic V1): the names are too common to match safely.
- `ConfigParser.readfp()`: `mimetypes.MimeTypes.readfp()` is a current method of the same name.
- The `failUnless*` and `failIf*` unittest aliases: Twisted trial defines methods of those names.
- `o1` and `o1-pro` (OpenAI, shut down 2026-10-23): two characters in quotes match too much.
- `gpt-4o`, `gpt-4o-mini`, `gpt-4.1` without a date: OpenAI's page lists the dated snapshots, not the alias.
- `gemini-pro`, `gemini-1.0-pro`, `text-bison`: no statement about them on the two Google pages read today.
- `stripe.redirectToCheckout` as a block, and a rule on `stripe.tokens.create`: Stripe.js v3 is not deprecated, and tokens are
  current for bank accounts and Connect.
- A rule for `new_classes` in Durable Object migrations, and for `nodejs_compat` on new compatibility dates: Cloudflare
  recommends against both without deprecating them.
- Next.js `middleware.ts` to `proxy.ts`, `next lint`, `serverRuntimeConfig`: true only on Next.js 16, and Next.js 15 is still
  maintained; a file name is also not a text pattern.
- supabase-js `@supabase/ssr` cookie methods `get`, `set`, `remove`: no pattern separates them from other cookie code.

## Sources

Each rule's `source` was fetched on 2026-11-21 and the sentence the rule rests on was found in the fetched text by a script
(61 rules, 27 pages, 0 not found). The wrangler-publish rule also rests on the Wrangler v3 to v4 migration page
("All previously deprecated features in Wrangler v2 and in Wrangler v3 are now removed"), and the block rules for Wrangler on
Cloudflare's 2025-03-13 changelog ("supporting Wrangler v3 with bug fixes and security updates until Q1 2026"). The Python block
rules rest on the Python developer guide's version table (3.14 and 3.15 take bug fixes; 3.11 to 3.13 take security fixes only).

## Repositories

| pack | repository | commit | commit date | part read |
|---|---|---|---|---|
| python-stdlib | django/django | 0eae0b2584ed | 2026-11-21 | all |
| python-stdlib | psf/requests | 3c7baaa05ab4 | 2026-10-26 | all |
| python-stdlib | pallets/flask | 49943b5a9441 | 2026-10-30 | all |
| python-stdlib | scrapy/scrapy | 00acf3f31a32 | 2026-11-19 | all |
| python-stdlib | python/cpython | 1cc580249141 | 2026-11-21 | Lib, Tools |
| python-stdlib | pypa/setuptools | 049ae8e30835 | 2026-10-29 | all |
| python-stdlib | gevent/gevent | 08f09eda118b | 2026-09-16 | all |
| python-stdlib | twisted/twisted | 8ea2370e8d34 | 2026-11-14 | all |
| python-stdlib | boto/boto | 70c65b4f67af | 2022-05-13 | all |
| pydantic-v2 | fastapi/fastapi | 05e6df7e906c | 2026-11-18 | all |
| pydantic-v2 | pydantic/pydantic-ai | 2b721c4bbf66 | 2026-11-21 | all |
| pydantic-v2 | fastapi/full-stack-fastapi-template | 77e550a73bb4 | 2026-11-16 | all |
| pydantic-v2 | openai/openai-python | f63f14b34754 | 2026-11-20 | all |
| fastapi | fastapi/fastapi | 05e6df7e906c | 2026-11-18 | all |
| fastapi | fastapi/full-stack-fastapi-template | 77e550a73bb4 | 2026-11-16 | all |
| fastapi | Netflix/dispatch | dd2837e82a0b | 2025-09-02 | all |
| nextjs-app-router | vercel/next.js | 257bb842e2e2 | 2026-11-21 | examples |
| nextjs-app-router | vercel/commerce | f7521d57d29f | 2026-10-19 | all |
| nextjs-app-router | vercel/ai-chatbot | a8989b522fa3 | 2026-11-03 | all |
| nextjs-app-router | shadcn-ui/taxonomy | 298a8857c712 | 2026-04-20 | all |
| nextjs-app-router | calcom/cal.com | ae027bb70e69 | 2026-11-13 | apps/web |
| cloudflare-workers | cloudflare/templates | 9674298a122a | 2026-11-18 | all |
| cloudflare-workers | cloudflare/workers-sdk | b00799168dc2 | 2026-11-20 | templates, fixtures, packages/create-cloudflare/templates |
| cloudflare-workers | cloudflare/workers-chat-demo | dd32ce87617a | 2025-07-15 | all |
| cloudflare-workers | honojs/examples | 3b0b62875a0e | 2026-03-21 | all |
| stripe | stripe-samples/accept-a-payment | a435916227b8 | 2026-11-18 | all |
| stripe | stripe/stripe-node | dd924299e251 | 2026-11-18 | all |
| stripe | stripe/stripe-python | 2bbff4304703 | 2026-11-18 | all |
| stripe | vercel/nextjs-subscription-payments | bdd0813206e4 | 2025-01-23 | all |
| supabase-auth | supabase/supabase | 4ead4b092ee7 | 2026-11-21 | examples |
| supabase-auth | mckaywrigley/chatbot-ui | 81328b61d2a4 | 2024-06-22 | all |
| supabase-auth | supabase-community/supabase-custom-claims | 254e656bf8b7 | 2023-09-18 | all |
| supabase-auth | vercel/nextjs-subscription-payments | bdd0813206e4 | 2025-01-23 | all |
| supabase-auth | vercel/nextjs-subscription-payments | bdd0813206e4 | 2025-01-23 | all |
| llm-models | anthropics/anthropic-sdk-python | 8baaef1c4d23 | 2026-11-20 | all |
| llm-models | simonw/llm | 46f0461d9b1e | 2026-11-17 | all |
| llm-models | BerriAI/litellm | 8f7c7f861acd | 2026-11-22 | all |
| llm-models | anthropics/claude-cookbooks | 8ad5de647d4f | 2026-11-20 | all |
| llm-models | google-gemini/cookbook | 61250eb5652b | 2026-11-19 | all |

Next.js: each folder under `examples/` in vercel/next.js was read as its own project root, and cal.com from `apps/web`.
