import { IsString, IsNotEmpty, IsOptional, Length } from 'class-validator';

export class AcceptInviteDto {
  @IsString()
  @IsNotEmpty()
  invitation_token: string;

  @IsString()
  @Length(1, 255)
  @IsOptional()
  password?: string;

  @IsString()
  @IsOptional()
  full_name?: string;
}
