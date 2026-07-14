-- Structured question types need more than html_content + answer.
-- ASCII-safe file. Run this in the Supabase SQL Editor.
--
-- meta holds the type-specific structure, e.g.
--   match        : { "left": ["(17-5)x2+1", "30-9x3+10"], "right": ["13", "25"] }
--   marker_only  : { "count": 5 }
--   fill_symbol  : { "expr": "12 O 3 O 2 = 8", "symbols": ["x", "/"], "once": true }
-- Answers stay in questions.answer (so the existing answer-key / grading path is unchanged):
--   match       -> "0:0,1:1,2:2"   (left index : right index, order ignored)
--   fill_symbol -> "x,/"           (in slot order)

alter table questions
  add column if not exists meta jsonb not null default '{}'::jsonb;

-- PostgREST schema cache reload
notify pgrst, 'reload schema';
