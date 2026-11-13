-- The autonomy new missions of an agent start with ("Usar como padrão"); null = low_risk_auto.
ALTER TABLE "agents" ADD COLUMN "mission_command_approval" text;
