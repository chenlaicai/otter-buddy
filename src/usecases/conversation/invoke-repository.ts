import type {
  Invoke,
  InvokeStatus,
  InvokeEvent,
} from "@entities/conversation/invoke";

export interface GetInvokesOptions {
  limit?: number;
  before?: string;
  status?: InvokeStatus;
  otterId?: string;
}

export interface InvokeRepository {
  // Invoke 生命周期
  createInvoke(invoke: Invoke): Promise<void>;
  updateInvokeStatus(
    invokeId: string,
    status: InvokeStatus,
    endedAt?: string,
  ): Promise<void>;
  updateInvokeTalkingStonePassedTo(
    invokeId: string,
    talkingStonePassedTo: string[],
  ): Promise<void>;
  updateInvokeToolCallCount(invokeId: string, count: number): Promise<void>;
  updateInvokeTokenUsage(
    invokeId: string,
    input: number,
    output: number,
  ): Promise<void>;
  updateInvokeMetadata(invokeId: string, metadata: Record<string, unknown>): Promise<void>;

  // Invoke 查询
  getInvokeById(id: string): Promise<Invoke | null>;
  getInvokes(
    conversationId: string,
    options?: GetInvokesOptions,
  ): Promise<Invoke[]>;
  getActiveInvokeByOtterId(
    conversationId: string,
    otterId: string,
  ): Promise<Invoke | null>;
  getInvokeByTriggerEntryId(triggerEntryId: string): Promise<Invoke | null>;

  // InvokeEvent
  appendInvokeEvent(event: InvokeEvent): Promise<void>;
  getInvokeEvents(invokeId: string): Promise<InvokeEvent[]>;
  getInvokeEventsByInvokeIds(invokeIds: string[]): Promise<InvokeEvent[]>;
  getMaxEventSequenceNum(invokeId: string): Promise<number>;
}
