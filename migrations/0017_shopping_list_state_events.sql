ALTER TYPE "public"."shopping_list_event_type" ADD VALUE IF NOT EXISTS 'shopping_state_replaced';--> statement-breakpoint
ALTER TYPE "public"."shopping_list_event_type" ADD VALUE IF NOT EXISTS 'shopping_list_cleared';
