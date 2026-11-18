export const HTTP_ROUTES = {
    "POST /extensions/capability-calls/:id/reads": {
        "policy": {
            "tokens": [
                "app"
            ],
            "permissions": []
        },
        "readOnly": true,
        "readPolicies": {
            "channels.list": {
                "tokens": [
                    "app"
                ],
                "permissions": [
                    "channels:list"
                ]
            },
            "channels.members.list": {
                "tokens": [
                    "app"
                ],
                "permissions": [
                    "channels:read-public-members"
                ]
            }
        }
    },
    "GET /app-projects": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "projects:list"
            ]
        },
        "alternatives": [
            {
                "tokens": [
                    "app"
                ],
                "permissions": [
                    "projects:list"
                ]
            }
        ]
    },
    "GET /app-channels": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "channels:list"
            ]
        },
        "alternatives": [
            {
                "tokens": [
                    "app"
                ],
                "permissions": [
                    "channels:list"
                ]
            }
        ]
    },
    "GET /app-channels/:id/messages": {
        "policy": {
            "tokens": [
                "app"
            ],
            "permissions": [
                "messages:read-public"
            ]
        },
        "alternatives": [
            {
                "tokens": [
                    "user"
                ],
                "permissions": [
                    "messages:read-private"
                ]
            }
        ]
    },
    "GET /app-channels/:id/members": {
        "policy": {
            "tokens": [
                "app"
            ],
            "permissions": [
                "channels:read-public-members"
            ]
        }
    },
    "POST /messages/:id/recall": {
        "policy": {
            "tokens": [
                "app"
            ],
            "permissions": [
                "messages:write"
            ]
        }
    },
    "GET /tasks": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "tasks:read"
            ]
        }
    },
    "GET /tasks/:id": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "tasks:read"
            ]
        }
    },
    "GET /personal-tasks": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "tasks:read"
            ]
        }
    },
    "GET /app-files": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "files:read"
            ]
        }
    },
    "GET /app-files/:id": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "files:read"
            ]
        }
    },
    "POST /app-files": {
        "policy": {
            "tokens": [
                "app"
            ],
            "permissions": [
                "files:upload"
            ]
        }
    },
    "GET /app-capabilities": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "apps:read"
            ]
        },
        "alternatives": [
            {
                "tokens": [
                    "app"
                ],
                "permissions": [
                    "apps:read"
                ]
            }
        ]
    },
    "GET /app-capabilities/:id/operations": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "apps:read"
            ]
        },
        "alternatives": [
            {
                "tokens": [
                    "app"
                ],
                "permissions": [
                    "apps:read"
                ]
            }
        ]
    },
    "POST /app-capabilities/:id/calls": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "apps:call"
            ]
        },
        "alternatives": [
            {
                "tokens": [
                    "app"
                ],
                "permissions": [
                    "apps:call"
                ]
            }
        ]
    },
    "GET /topics": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "topics:list"
            ]
        }
    },
    "GET /topics/:id/messages": {
        "policy": {
            "tokens": [
                "app"
            ],
            "permissions": [
                "messages:read-public"
            ]
        },
        "alternatives": [
            {
                "tokens": [
                    "user"
                ],
                "permissions": [
                    "messages:read-private"
                ]
            }
        ]
    },
    "GET /messages/:id": {
        "policy": {
            "tokens": [
                "app"
            ],
            "permissions": [
                "messages:read-public"
            ]
        },
        "alternatives": [
            {
                "tokens": [
                    "user"
                ],
                "permissions": [
                    "messages:read-private"
                ]
            }
        ]
    },
    "GET /app-direct-messages/:conversationId/messages": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "messages:read-private"
            ]
        }
    },
    "GET /app-direct-messages/:conversationId/attachments/:artifactId/download": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "files:read"
            ]
        }
    },
    "GET /topics/:id/images/:artifactId": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "files:read"
            ]
        }
    },
    "GET /topics/:id/participants": {
        "policy": {
            "tokens": [
                "app"
            ],
            "permissions": [
                "messages:read-public"
            ]
        },
        "alternatives": [
            {
                "tokens": [
                    "user"
                ],
                "permissions": [
                    "messages:read-private"
                ]
            }
        ]
    },
    "PUT /messages/:id": {
        "policy": {
            "tokens": [
                "app"
            ],
            "permissions": [
                "messages:write"
            ]
        }
    },
    "POST /messages": {
        "policy": {
            "tokens": [
                "app"
            ],
            "permissions": [
                "messages:write"
            ]
        }
    },
    "POST /message-drafts": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "messages:draft"
            ]
        }
    },
    "POST /agent-sessions/status": {
        "policy": {
            "tokens": [
                "app"
            ],
            "permissions": [
                "messages:write"
            ]
        }
    },
    "GET /channels/:id/unread-messages": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "channels:read-unread"
            ]
        }
    },
    "GET /extensions/contacts": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "contacts:select"
            ]
        }
    },
    "GET /extensions/contact-channels": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "contacts:select"
            ]
        }
    },
    "GET /extensions/contact-projects": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "contacts:select"
            ]
        }
    },
    "POST /extensions/participant-selections": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "contacts:select"
            ]
        },
        "readOnly": true
    },
    "PUT /app-files/:fileId/content": {
        "policy": {
            "tokens": [
                "app"
            ],
            "permissions": [
                "files:upload"
            ]
        }
    },
    "GET /app-files/:fileId/content": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "files:read"
            ]
        }
    },
    "POST /tasks": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "tasks:manage"
            ]
        }
    },
    "POST /tasks/:id": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": [
                "tasks:manage"
            ]
        }
    },
    "POST /tasks/:id/execution-reports": {
        "policy": {
            "tokens": [
                "app"
            ],
            "permissions": [
                "tasks:execute"
            ]
        }
    },
    "POST /extensions/ui-requests": {
        "policy": {
            "tokens": [
                "app"
            ],
            "permissions": [
                "messages:receive"
            ]
        }
    },
    "GET /extensions/ui-requests/:id": {
        "policy": {
            "tokens": [
                "app"
            ],
            "permissions": [
                "messages:receive"
            ]
        }
    },
    "POST /extensions/ui-requests/:id/complete": {
        "policy": {
            "tokens": [
                "user"
            ],
            "permissions": []
        }
    },
    "POST /extensions/agent-apps/receipts": {
        "policy": {
            "tokens": [
                "app"
            ],
            "permissions": [
                "messages:receive"
            ]
        }
    }
};
export const MCP_OPERATIONS = {
    "colink_read_platform": "platform.read",
    "colink_list_user_projects": "projects.list",
    "colink_list_app_projects": "projects.list",
    "colink_list_user_channels": "channels.list",
    "colink_list_app_channels": "channels.list",
    "colink_list_user_topics": "topics.list",
    "colink_list_my_tasks": "tasks.personal.list",
    "colink_read_private_topic": "messages.topic.read",
    "colink_read_public_topic": "messages.topic.read",
    "colink_read_private_channel": "messages.channel.read",
    "colink_read_public_channel": "messages.channel.read",
    "colink_read_channel_unread": "channels.unread.read",
    "colink_list_members": "channels.members.list",
    "colink_send_message": "messages.send",
    "colink_send_draft": "messages.draft",
    "colink_recall_message": "messages.recall",
    "colink_upload_file": "files.upload",
    "colink_list_files": "files.list",
    "colink_read_file": "files.read",
    "colink_create_task": "tasks.create",
    "colink_get_task": "tasks.get",
    "colink_list_tasks": "tasks.list",
    "colink_update_task": "tasks.update",
    "colink_report_task": "tasks.report",
    "colink_app_find_as_user": "apps.find",
    "colink_app_find_as_app": "apps.find",
    "colink_app_guide_as_user": "apps.guide",
    "colink_app_guide_as_app": "apps.guide",
    "colink_app_call_as_user": "apps.call",
    "colink_app_call_as_app": "apps.call",
    "colink_app_prepare": "apps.deploy",
    "colink_app_finalize": "apps.deploy",
    "colink_app_install": "apps.deploy",
    "colink_app_status": "apps.deploy",
    "colink_app_update_preview": "apps.deploy",
    "colink_app_update": "apps.deploy",
    "colink_app_delete_preview": "apps.deploy",
    "colink_app_delete": "apps.deploy"
};
export const MCP_POLICIES = {
    "colink_read_platform": {
        "tokens": [
            "app",
            "user"
        ],
        "permissions": []
    },
    "colink_list_user_projects": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "projects:list"
        ]
    },
    "colink_list_app_projects": {
        "tokens": [
            "app"
        ],
        "permissions": [
            "projects:list"
        ]
    },
    "colink_list_user_channels": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "channels:list"
        ]
    },
    "colink_list_user_topics": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "topics:list"
        ]
    },
    "colink_list_app_channels": {
        "tokens": [
            "app"
        ],
        "permissions": [
            "channels:list"
        ]
    },
    "colink_list_my_tasks": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "tasks:read"
        ]
    },
    "colink_read_private_topic": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "messages:read-private"
        ]
    },
    "colink_read_public_topic": {
        "tokens": [
            "app"
        ],
        "permissions": [
            "messages:read-public"
        ]
    },
    "colink_read_private_channel": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "messages:read-private"
        ]
    },
    "colink_read_public_channel": {
        "tokens": [
            "app"
        ],
        "permissions": [
            "messages:read-public"
        ]
    },
    "colink_read_channel_unread": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "channels:read-unread"
        ]
    },
    "colink_list_members": {
        "tokens": [
            "app"
        ],
        "permissions": [
            "channels:read-public-members"
        ]
    },
    "colink_send_message": {
        "tokens": [
            "app"
        ],
        "permissions": [
            "messages:write"
        ]
    },
    "colink_send_draft": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "messages:draft"
        ]
    },
    "colink_recall_message": {
        "tokens": [
            "app"
        ],
        "permissions": [
            "messages:write"
        ]
    },
    "colink_upload_file": {
        "tokens": [
            "app"
        ],
        "permissions": [
            "files:upload"
        ]
    },
    "colink_list_files": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "files:read"
        ]
    },
    "colink_read_file": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "files:read"
        ]
    },
    "colink_create_task": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "tasks:manage"
        ]
    },
    "colink_get_task": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "tasks:read"
        ]
    },
    "colink_list_tasks": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "tasks:read"
        ]
    },
    "colink_update_task": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "tasks:manage"
        ]
    },
    "colink_report_task": {
        "tokens": [
            "app"
        ],
        "permissions": [
            "tasks:execute"
        ]
    },
    "colink_app_find_as_user": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "apps:read"
        ]
    },
    "colink_app_find_as_app": {
        "tokens": [
            "app"
        ],
        "permissions": [
            "apps:read"
        ]
    },
    "colink_app_guide_as_user": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "apps:read"
        ]
    },
    "colink_app_guide_as_app": {
        "tokens": [
            "app"
        ],
        "permissions": [
            "apps:read"
        ]
    },
    "colink_app_call_as_user": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "apps:call"
        ]
    },
    "colink_app_call_as_app": {
        "tokens": [
            "app"
        ],
        "permissions": [
            "apps:call"
        ]
    },
    "colink_app_prepare": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "app:manage"
        ]
    },
    "colink_app_finalize": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "app:manage"
        ]
    },
    "colink_app_install": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "app:manage"
        ]
    },
    "colink_app_status": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "app:manage"
        ]
    },
    "colink_app_update_preview": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "app:manage"
        ]
    },
    "colink_app_update": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "app:manage"
        ]
    },
    "colink_app_delete_preview": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "app:manage"
        ]
    },
    "colink_app_delete": {
        "tokens": [
            "user"
        ],
        "permissions": [
            "app:manage"
        ]
    }
};
export const MCP_ERROR_STATUS = { "APP_API_CONTEXT_UNAVAILABLE": 403, "APP_API_CONTEXT_VERSION_UNSUPPORTED": 409, "APP_API_TASK_EPOCH_STALE": 409, "APP_API_UNAVAILABLE": 503, "APP_API_TOKEN_INVALID": 401, "APP_API_SIGNATURE_INVALID": 401, "APP_API_INSTALLATION_UNAVAILABLE": 403, "APP_API_CATALOG_UNAVAILABLE": 503, "APP_API_OPERATION_NOT_FOUND": 404, "APP_API_SPEC_CHANGED": 409, "APP_API_INPUT_INVALID": 400, "APP_API_BUSINESS_REJECTED": 409, "APP_API_RESULT_UNVERIFIED": 503, "APP_API_RESULT_EXPIRED": 410, "APP_API_EXECUTION_EXPIRED": 409, "APP_API_RATE_LIMITED": 429, "INVALID_CURSOR": 400, "VALIDATION_FAILED": 400, "USER_SESSION_INVALID": 401, "SCOPE_MISSING": 403, "ACCESS_DENIED": 403, "RESOURCE_UNAVAILABLE": 404, "SITE_OUT_OF_SCOPE": 403, "DELIVERY_DENIED": 403, "TASK_VERSION_CONFLICT": 409, "TASK_EPOCH_STALE": 409, "TASK_STATE_INVALID": 409, "IDEMPOTENCY_KEY_CONFLICT": 409, "FILE_TRANSFER_TOKEN_INVALID": 401, "FILE_TOO_LARGE": 413, "FILE_CONTENT_TYPE_INVALID": 415, "FILE_LENGTH_REQUIRED": 411, "FILE_CONTENT_MISMATCH": 400, "IDEMPOTENCY_IN_PROGRESS": 409, "FILE_QUOTA_EXCEEDED": 409, "FILE_TRANSFER_RATE_LIMITED": 429, "FILE_RANGE_INVALID": 416, "FILE_TRANSFER_UNAVAILABLE": 503, "APP_DEPLOY_SYSTEM_NOT_SELF_HOSTED": 403, "APP_DEPLOY_UNSUPPORTED_SCOPE": 400, "APP_DEPLOY_PROJECT_FORBIDDEN": 403, "APP_DEPLOY_NOT_READY": 409, "APP_DEPLOY_CONFLICT": 409, "APP_DEPLOY_VERIFY_FAILED": 502, "APP_DEPLOY_UPSTREAM_FAILED": 502, "APP_DEPLOY_LIMIT": 429, "APP_DEPLOY_SECRET_UNAVAILABLE": 503, "INTERNAL_ERROR": 500 };
export const MANIFEST_SCOPES = { "messages:read-private": { "declarableInManifest": true, "identities": ["user"] }, "messages:read-public": { "declarableInManifest": true, "identities": ["app"] }, "messages:write": { "declarableInManifest": true, "identities": ["app"] }, "messages:draft": { "declarableInManifest": true, "identities": ["user"] }, "messages:receive": { "declarableInManifest": true, "identities": ["app"] }, "channels:read-public-members": { "declarableInManifest": true, "identities": ["app"] }, "channels:read-unread": { "declarableInManifest": true, "identities": ["user"] }, "files:read": { "declarableInManifest": true, "identities": ["user"] }, "files:upload": { "declarableInManifest": true, "identities": ["app"] }, "tasks:read": { "declarableInManifest": true, "identities": ["user"] }, "tasks:manage": { "declarableInManifest": true, "identities": ["user"], "includes": ["tasks:read"] }, "tasks:execute": { "declarableInManifest": true, "identities": ["app"] }, "contacts:select": { "declarableInManifest": true, "identities": ["user"], "userPageOnly": true }, "projects:list": { "declarableInManifest": true, "identities": ["app", "user"] }, "channels:list": { "declarableInManifest": true, "identities": ["app", "user"], "systemUserProjectOnly": true }, "topics:list": { "declarableInManifest": true, "identities": ["user"] }, "apps:read": { "declarableInManifest": true, "identities": ["app", "user"] }, "apps:call": { "declarableInManifest": true, "identities": ["app", "user"] }, "app:manage": { "declarableInManifest": true, "identities": ["user"] } };
export const EVENT_POLICIES = { "app.user_message_received": { "tokens": ["app"], "permissions": ["messages:receive"] }, "app.collaboration_message_received": { "tokens": ["app"], "permissions": ["messages:receive"] }, "app.colink_ui_action_invoked": { "tokens": ["app"], "permissions": ["messages:receive"] }, "app.message_processing_cancelled": { "tokens": ["app"], "permissions": ["messages:receive"] }, "task.execution_requested": { "tokens": ["app"], "permissions": ["tasks:execute"] }, "task.execution_cancelled": { "tokens": ["app"], "permissions": ["tasks:execute"] } };
export const SCOPE_REQUIRES = {};
export const USER_SCOPES = ["messages:read-private", "messages:draft", "channels:read-unread", "files:read", "tasks:read", "tasks:manage", "contacts:select", "projects:list", "channels:list", "topics:list", "apps:read", "apps:call", "app:manage", "openid", "profile"];
export const BACKGROUND_SCOPES = ["messages:read-private", "messages:draft", "channels:read-unread", "files:read", "tasks:read", "tasks:manage", "projects:list", "channels:list", "topics:list", "apps:read", "apps:call", "app:manage"];
