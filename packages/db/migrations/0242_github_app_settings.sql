-- deploy-safe: the new check allows all the old one did, and the previous version never writes 'github_app'
ALTER TABLE "instance_secrets" DROP CONSTRAINT "instance_secrets_name";--> statement-breakpoint
ALTER TABLE "instance_secrets" ADD CONSTRAINT "instance_secrets_name" CHECK ("instance_secrets"."name" in ('typesafe', 'giphy', 'speech', 'github_app'));