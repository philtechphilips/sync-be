import { IsString, IsNotEmpty, IsOptional, IsEnum } from 'class-validator';


export class CreateWorkspaceDto {
  @IsString()
  @IsNotEmpty()
  name: string;


  @IsNotEmpty()
  industry_type: string;

  @IsString()
  @IsNotEmpty()
  workspace_url: string;

  @IsString()
  @IsOptional()
  description?: string;
}
