-- Custom SQL migration file, put your code below! --

-- user_profiles has no rows yet in production (feature just shipped) — a
-- plain ALTER is safe, no backfill needed for the display_name -> given/family
-- split.
alter table "user_profiles" add column "given_name" text;
alter table "user_profiles" add column "family_name" text;
alter table "user_profiles" alter column "given_name" set not null;
alter table "user_profiles" drop column "display_name";
