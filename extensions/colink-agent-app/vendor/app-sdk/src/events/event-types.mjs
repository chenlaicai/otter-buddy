// Check every wire value before bridging the public nominal enum to its plain,
// frozen JavaScript representation (no runtime enum transform is needed).
export const EventType = Object.freeze({
    "UserMessageReceived": "app.user_message_received",
    "CollaborationMessageReceived": "app.collaboration_message_received",
    "CoLinkUiActionInvoked": "app.colink_ui_action_invoked",
    "MessageProcessingCancelled": "app.message_processing_cancelled",
    "TaskExecutionRequested": "task.execution_requested",
    "TaskExecutionCancelled": "task.execution_cancelled"
});
