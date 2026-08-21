import { W3CTraceContextPropagator } from '@opentelemetry/core'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NoopSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web'

import type { TraceConfig } from '../trace-core/types/config'
import { defaultConfig } from '../trace-core/types/config'
import { TopicContextManager } from './TopicContextManager'

export const contextManager = new TopicContextManager()

export class WebTracer {
  private static provider: WebTracerProvider
  private static processor: SpanProcessor

  static init(config?: TraceConfig, spanProcessor?: SpanProcessor) {
    if (config) {
      defaultConfig.serviceName = config.serviceName || defaultConfig.serviceName
      defaultConfig.endpoint = config.endpoint || defaultConfig.endpoint
      defaultConfig.headers = config.headers || defaultConfig.headers
      defaultConfig.defaultTracerName = config.defaultTracerName || defaultConfig.defaultTracerName
    }
    // Never export spans automatically. A caller may provide an explicit local processor.
    this.processor = spanProcessor || new NoopSpanProcessor()
    this.provider = new WebTracerProvider({
      spanProcessors: [this.processor]
    })
    this.provider.register({
      propagator: new W3CTraceContextPropagator(),
      contextManager: contextManager
    })
  }
}

export const startContext = contextManager.startContextForTopic.bind(contextManager)
export const getContext = contextManager.getContextForTopic.bind(contextManager)
export const endContext = contextManager.endContextForTopic.bind(contextManager)
export const cleanContext = contextManager.cleanContextForTopic.bind(contextManager)
