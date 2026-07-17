/** 领域错误类型（use case 层抛出，controller 层映射为 HTTP 状态码） */
export type DomainErrorKind =
  | "not_found"
  | "conflict"
  | "validation"
  | "forbidden";

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly kind: DomainErrorKind,
  ) {
    super(message);
  }
}
