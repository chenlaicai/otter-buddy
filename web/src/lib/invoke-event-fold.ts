/** F20261013csv3 T5：fold 逻辑已迁入 contract 层（api-contract/api/invoke-event-fold.ts），
 *  前后端共用同一实现。本文件保留 re-export，既有消费方（SessionModal/测试）导入路径不变。 */
export { foldInvokeEvents, type FoldedStep } from '@contract/api/invoke-event-fold'
