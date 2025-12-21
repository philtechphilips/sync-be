import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsEmail,
} from 'class-validator';

export class CreateWorkspaceDto {
  @IsString()
  @IsNotEmpty()
  company_name: string;

  @IsString()
  @IsNotEmpty()
  company_domain: string;

  @IsString()
  @IsNotEmpty()
  industry_type: string;

  @IsString()
  @IsNotEmpty()
  admin_full_name: string;

  @IsEmail()
  @IsNotEmpty()
  admin_email: string;

  @IsString()
  @IsNotEmpty()
  admin_password: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsString()
  @IsNotEmpty()
  workspace_name: string;

  @IsString()
  @IsNotEmpty()
  workspace_url: string;

  @IsString()
  @IsNotEmpty()
  onboarding_plan: string;
}
