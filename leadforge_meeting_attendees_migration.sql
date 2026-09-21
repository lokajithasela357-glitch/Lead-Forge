-- LeadForge -- Meeting Attendees + Live Task Sync migration
-- Run this once in your Supabase project's SQL Editor (Project -> SQL Editor -> New query).
-- Safe to run more than once -- every statement below is written to be idempotent.
--
-- What this adds:
--   1. A structured `attendee_ids` column on lead_tasks, so a Meeting can carry
--      real invited user accounts (not just free-text names/emails), which is
--      what lets LeadForge notify them and put the meeting on their calendar.
--   2. Adds `lead_tasks` to the `supabase_realtime` publication, so a task
--      completed / rescheduled / added / deleted by one person (or one
--      session) shows up immediately for everyone else who already has
--      LeadForge open -- Agenda, Calendar, the Lead Drawer, and the
--      Dashboard's Alerts banner all update live instead of only on the
--      next manual Refresh or app restart.

-- 1. Structured attendee list -----------------------------------------------
alter table if exists public.lead_tasks
  add column if not exists attendee_ids jsonb not null default '[]'::jsonb;

comment on column public.lead_tasks.attendee_ids is
  'Array of profiles.id UUIDs invited to this Meeting. Distinct from the '
  'free-text "attendees" column, which stays for external/non-account names.';

-- 2. Realtime publication ----------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lead_tasks'
  ) then
    alter publication supabase_realtime add table public.lead_tasks;
  end if;
end $$;

-- 3. OPTIONAL, tighter visibility for invited attendees ----------------------
-- LeadForge's client already makes an invited-to standalone meeting visible
-- to every invitee today by marking it org-shared (is_shared = true)
-- whenever it has attendees -- no SQL required for that to work.
--
-- The one gap that leaves: a LEAD-LINKED meeting's visibility is still
-- inherited entirely from its parent lead's assigned rep (by design, so a
-- teammate can't see a lead they don't own just because a task on it exists).
-- If you want an invited attendee to see a lead-linked meeting even when
-- they're not that lead's assigned rep or an Admin, add a SELECT policy like
-- the one below -- adjust the auth.uid() -> profile-id comparison to however
-- your other lead_tasks policies already resolve the current user (this
-- assumes RLS is enabled on lead_tasks and auth.uid() equals profiles.id,
-- which is the normal Supabase Auth setup this app expects).
--
-- create policy "lead_tasks_select_attendee" on public.lead_tasks
-- for select
-- using (
--   attendee_ids @> to_jsonb(auth.uid()::text)
-- );
--
-- This is commented out deliberately -- it's additive to whatever SELECT
-- policy you already have (Postgres RLS policies are OR'd together), so
-- uncommenting and running it only ever WIDENS visibility, never narrows it.
