import { IsString, IsNotEmpty, IsEmail, IsEnum, IsBoolean, IsOptional, ValidateNested, IsArray } from 'class-validator';
import { WorkspaceRole } from '../enums/workspace-role.enum';
import { Type } from 'class-transformer';

export class InviteMemberDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsEnum(WorkspaceRole)
  @IsNotEmpty()
  role: WorkspaceRole;
}

export class InviteMembersDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InviteMemberDto)
  @IsNotEmpty()
  members: InviteMemberDto[];

  @IsBoolean()
  @IsOptional()
  can_invite_teammates?: boolean;

  @IsBoolean()
  @IsOptional()
  can_manage_settings?: boolean;

  @IsBoolean()
  @IsOptional()
  can_view_analytics?: boolean;
}

